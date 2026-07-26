#!/usr/bin/env bash
# scripts/check-aca-arm-parity.sh — ACA sandbox group ARM parity gate (M5).
#
# Verifies that the AzAPI body in infra/azure/terraform/sandbox.tf mirrors the
# canonical ARM shape in infra/azure/bicep/sandbox-group.bicep,
# property-for-property and order-insensitively.
#
# Pipeline:
#   1. Build the Bicep reference to ARM JSON (bicep build --stdout), extract
#      the relevant location, identity, properties, and tags resource shape.
#   2. Heuristically extract the `azapi_resource "sandbox_group"` ->
#      `body = { ... }` HCL object literal from sandbox.tf, convert it to
#      JSON via a small recursive-descent HCL-object parser (see below), and
#      combine it with the resource's location, identity, and tags arguments.
#   3. Normalize equivalent Bicep/Terraform parameter references and compare
#      the complete objects with jq. Fail on any key or value difference.
#
# Dependencies: bicep, python3, jq.
#
# CAVEAT — HEURISTIC EXTRACTION. The Terraform extractor is a tiny hand-rolled
# HCL-object parser, NOT a real Terraform engine. It handles the subset of
# HCL object-literal syntax this repo's sandbox.tf uses: `{ key = value, ... }`
# with nested objects, arrays, and string/number/bool/null scalars. It does
# NOT evaluate HCL functions (jsonencode, etc.), interpolation
# (`${...}`), or tfvars — it parses the *literal* text inside `body = { ... }`
# only. If sandbox.tf changes shape dramatically (e.g. body becomes a heredoc
# string, a `jsonencode(...)` call instead of an object literal, or pulls
# properties from variables), update the extractor or switch to
# `terraform plan -generate-config-out` for a real evaluation.
#
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." -- && pwd)"
BICEP_FILE="${REPO_ROOT}/infra/azure/bicep/sandbox-group.bicep"
TF_FILE="${REPO_ROOT}/infra/azure/terraform/sandbox.tf"

for dep in bicep python3 jq; do
  if ! command -v "$dep" >/dev/null 2>&1; then
    echo "error: required binary '$dep' not found on PATH" >&2
    exit 2
  fi
done

if [[ ! -f "$BICEP_FILE" ]]; then
  echo "error: bicep reference not found: $BICEP_FILE" >&2
  exit 2
fi
if [[ ! -f "$TF_FILE" ]]; then
  echo "error: terraform sandbox.tf not found: $TF_FILE" >&2
  exit 2
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

bicep_json="$tmp/bicep.json"
bicep build "$BICEP_FILE" --stdout > "$bicep_json"

# Step 1: extract and normalize Bicep's complete relevant resource shape.
bicep_shape="$tmp/bicep-shape.json"
jq -c '
  [.resources[] | select(.type == "Microsoft.App/sandboxGroups")] as $gs
  | if ($gs | length) != 1 then
      error("expected exactly one Microsoft.App/sandboxGroups resource, found \($gs | length)")
    else
      $gs[0]
      | {
          location: (if .location == "[parameters(\u0027location\u0027)]" then "$location" else .location end),
          identity: .identity,
          properties: (.properties // {}),
          tags: (if .tags == "[parameters(\u0027tags\u0027)]" then "$tags" else .tags end)
        }
    end
' "$bicep_json" > "$bicep_shape"

# Step 2: extract Terraform's azapi_resource.sandbox_group body object literal
# and convert it to JSON. The python helper writes the full body object (the
# value of `body = { ... }`) and normalized resource metadata as JSON.
tf_shape="$tmp/tf-shape.json"
python3 - "$TF_FILE" "$tf_shape" <<'PY'
import json, re, sys

tf_path, out_path = sys.argv[1], sys.argv[2]
src = open(tf_path, encoding="utf-8").read()

def strip_comments(s):
    """Remove # / // line comments and /* */ block comments. Best-effort."""
    out = []
    i, n = 0, len(s)
    line_comment = False
    while i < n:
        c = s[i]
        nxt = s[i + 1] if i + 1 < n else ""
        if line_comment:
            if c == "\n":
                line_comment = False
                out.append(c)
            i += 1
            continue
        if c == "#":
            line_comment = True
            i += 1
            continue
        if c == "/" and nxt == "/":
            line_comment = True
            i += 2
            continue
        if c == "/" and nxt == "*":
            end = s.find("*/", i + 2)
            if end == -1:
                raise ValueError("unterminated /* */ block comment")
            i = end + 2
            continue
        out.append(c)
        i += 1
    return "".join(out)

src = strip_comments(src)

# Locate `resource "azapi_resource" "sandbox_group" { ... }` (brace-balanced).
def find_resource(name):
    # match the resource header with the specific label
    pat = re.compile(r'resource\s+"azapi_resource"\s+"' + re.escape(name) + r'"\s*\{')
    m = pat.search(src)
    if not m:
        raise ValueError(f"resource azapi_resource \"{name}\" not found in {tf_path}")
    start = m.end()
    depth = 1
    i = start
    in_str = False
    str_q = None
    while i < len(src) and depth > 0:
        ch = src[i]
        if in_str:
            if ch == "\\":
                i += 2
                continue
            if ch == str_q:
                in_str = False
            i += 1
            continue
        if ch in ('"', "'"):
            in_str = True
            str_q = ch
            i += 1
            continue
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return start, i
        i += 1
    raise ValueError(f"unbalanced braces in resource {name}")

r_start, r_end = find_resource("sandbox_group")
resource_body = src[r_start:r_end]

# Within the resource, find `body = { ... }` (brace-balanced, first top-level
# occurrence — there is exactly one body block for azapi_resource).
m = re.search(r'\bbody\s*=\s*\{', resource_body)
if not m:
    raise ValueError("`body = { ... }` not found inside azapi_resource \"sandbox_group\"")
b_start = m.end()
depth = 1
i = b_start
in_str = False
str_q = None
while i < len(resource_body) and depth > 0:
    ch = resource_body[i]
    if in_str:
        if ch == "\\":
            i += 2
            continue
        if ch == str_q:
            in_str = False
        i += 1
        continue
    if ch in ('"', "'"):
        in_str = True
        str_q = ch
        i += 1
        continue
    if ch == "{":
        depth += 1
    elif ch == "}":
        depth -= 1
        if depth == 0:
            break
    i += 1
if depth != 0:
    raise ValueError("unbalanced braces in body block")
body_literal = resource_body[b_start:i]

# Recursive-descent HCL object-literal parser.  Grammar (subset):
#   value  := object | array | string | number | bool | null | ident
#   object := '{' (key '=' value (',' | newline)?)* '}'
#   array  := '[' (value (',' | newline)?)* ']'
#   string := '"' ... '"' | "'" ... "'"
#   key    := identifier (bare) | string
# Comments already stripped above.
class P:
    def __init__(self, s):
        self.s = s
        self.i = 0
        self.n = len(s)
    def skip_ws(self):
        while self.i < self.n:
            c = self.s[self.i]
            if c in " \t\r\n,":
                self.i += 1
            else:
                break
    def peek(self):
        self.skip_ws()
        return self.s[self.i] if self.i < self.n else ""
    def parse_value(self):
        self.skip_ws()
        if self.i >= self.n:
            raise ValueError("unexpected EOF parsing value")
        c = self.s[self.i]
        if c == "{":
            return self.parse_object()
        if c == "[":
            return self.parse_array()
        if c in ('"', "'"):
            return self.parse_string()
        # bare token: true/false/null/number/identifier
        return self.parse_token()
    def parse_object(self):
        # assume current char is '{'
        self.i += 1
        obj = {}
        while True:
            self.skip_ws()
            if self.i >= self.n:
                raise ValueError("unterminated object")
            if self.s[self.i] == "}":
                self.i += 1
                return obj
            key = self.parse_key()
            self.skip_ws()
            if self.i >= self.n or self.s[self.i] != "=":
                raise ValueError(f"expected '=' after key {key!r} at offset {self.i}")
            self.i += 1
            val = self.parse_value()
            obj[key] = val
    def parse_key(self):
        self.skip_ws()
        c = self.s[self.i]
        if c in ('"', "'"):
            return self.parse_string()
        m = re.match(r'[A-Za-z_][A-Za-z0-9_-]*', self.s[self.i:])
        if not m:
            raise ValueError(f"bad key at offset {self.i}: {self.s[self.i:self.i+20]!r}")
        key = m.group(0)
        self.i += len(key)
        return key
    def parse_array(self):
        self.i += 1
        arr = []
        while True:
            self.skip_ws()
            if self.i >= self.n:
                raise ValueError("unterminated array")
            if self.s[self.i] == "]":
                self.i += 1
                return arr
            arr.append(self.parse_value())
    def parse_string(self):
        q = self.s[self.i]
        self.i += 1
        buf = []
        while self.i < self.n:
            c = self.s[self.i]
            if c == "\\" and self.i + 1 < self.n:
                nx = self.s[self.i + 1]
                esc = {"n": "\n", "t": "\t", "r": "\r", "\\": "\\", '"': '"', "'": "'", "/": "/", "0": "\0"}
                buf.append(esc.get(nx, nx))
                self.i += 2
                continue
            if c == q:
                self.i += 1
                return "".join(buf)
            buf.append(c)
            self.i += 1
        raise ValueError("unterminated string")
    def parse_token(self):
        m = re.match(r'[^\s,\]\}]+', self.s[self.i:])
        if not m:
            raise ValueError(f"bad token at offset {self.i}")
        tok = m.group(0)
        self.i += len(tok)
        low = tok.lower()
        if low == "true":
            return True
        if low == "false":
            return False
        if low in ("null", "none"):
            return None
        num = re.fullmatch(r'-?\d+(\.\d+)?', tok)
        if num:
            return float(tok) if "." in tok else int(tok)
        # Bare tokens are treated as enum strings (e.g. UserAssigned).
        return tok

# body_literal is the *inner* content of the body object (outer braces were
# the delimiters we brace-matched on). Wrap with braces so the parser treats
# it as an object.
parsed = P("{" + body_literal + "}").parse_value()
if not isinstance(parsed, dict):
    raise ValueError(f"parsed body is not an object: {type(parsed)}")

def assignment(name):
    match = re.search(r'^\s*' + re.escape(name) + r'\s*=\s*([^\s]+)', resource_body, re.MULTILINE)
    if not match:
        raise ValueError(f"missing {name} assignment on sandbox_group")
    return match.group(1).strip('"')

identity_match = re.search(r'\bidentity\s*\{([^}]*)\}', resource_body, re.DOTALL)
if not identity_match:
    raise ValueError("missing identity block on sandbox_group")
identity_type_match = re.search(r'\btype\s*=\s*"([^"]+)"', identity_match.group(1))
if not identity_type_match:
    raise ValueError("missing identity type on sandbox_group")

location = assignment("location")
tags = assignment("tags")
shape = dict(parsed)
shape.update({
    "location": "$location" if location == "var.location" else location,
    "identity": {"type": identity_type_match.group(1)},
    "tags": "$tags" if tags == "local.default_tags" else tags,
})
with open(out_path, "w", encoding="utf-8") as f:
    json.dump(shape, f, indent=2, sort_keys=True, ensure_ascii=False)
PY

if [[ ! -s "$tf_shape" ]]; then
  echo "error: failed to extract/parse sandbox group shape from $TF_FILE" >&2
  exit 1
fi

# Step 3: compare normalized complete values, order-insensitively.
bicep_normalized="$tmp/bicep-normalized.json"
tf_normalized="$tmp/tf-normalized.json"
jq -S . "$bicep_shape" > "$bicep_normalized"
jq -S . "$tf_shape" > "$tf_normalized"

if diff -u "$bicep_normalized" "$tf_normalized"; then
  echo "ACA sandbox group ARM parity: Bicep == Terraform"
  echo "  normalized shape: $(jq -cS . "$bicep_shape")"
  exit 0
else
  echo "ACA sandbox group ARM parity FAIL: normalized resource shapes differ" >&2
  echo "  bicep: $(jq -cS . "$bicep_shape")" >&2
  echo "  tf:    $(jq -cS . "$tf_shape")" >&2
  exit 1
fi
