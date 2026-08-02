# Git & GitHub Setup

Cyrus uses your local Git and GitHub CLI (`gh`) authentication to create commits and pull requests. This guide explains how to configure these tools and what permissions Cyrus will have.

---

## Understanding Permissions

**Important:** Cyrus operates with the same permissions as your authenticated Git and GitHub CLI user.

When Cyrus creates commits and PRs:
- All commits are attributed to your Git user (`git config user.name` and `user.email`)
- All PRs are created under your GitHub account
- Your repository access permissions apply to all operations
- Co-authored-by attribution is disabled by default (configured via `.claude/settings.json`)

This means Cyrus can access any repository your authenticated user can access. Configure authentication carefully based on what repositories you want Cyrus to work with.

---

## Git Configuration

Configure Git with your identity:

```bash
git config --global user.name "Your Name"
git config --global user.email "your.email@example.com"
```

### SSH Authentication (Recommended)

Set up SSH keys for Git operations:

```bash
# Generate SSH key (if you don't have one)
ssh-keygen -t ed25519 -C "your.email@example.com"

# Start the SSH agent
eval "$(ssh-agent -s)"

# Add your key to the agent
ssh-add ~/.ssh/id_ed25519

# Copy the public key
cat ~/.ssh/id_ed25519.pub
```

Add the public key to your GitHub account at [github.com/settings/keys](https://github.com/settings/keys).

---

## GitHub CLI Setup

Install and authenticate the GitHub CLI for PR creation:

### Installation

**macOS:**
```bash
brew install gh
```

**Linux (Debian/Ubuntu):**
```bash
sudo apt install gh
```

**Other platforms:** See [cli.github.com](https://cli.github.com/)

### Authentication

```bash
gh auth login
```

Follow the prompts to authenticate. For servers without a browser, use a personal access token:

```bash
gh auth login --with-token < token.txt
```

### Token Scopes

If you authenticate with a **classic personal access token**, these are the scopes that matter:

| Scope | Needed? | What it covers |
| --- | --- | --- |
| `repo` | **Yes, for private repositories** | The functional minimum. Covers clone, fetch, commit, push, and reading/writing issues and pull requests. |
| `public_repo` | Only if every repository is public | Same as `repo` but public repositories only. |
| `read:org` | **Only for organization-level queries** | Listing an org's teams/members/repositories. Not used by the core clone → commit → push → open-PR flow. |
| `workflow` | Only to push changes under `.github/workflows/` | GitHub rejects workflow-file pushes without it. |

`repo` alone is enough for normal Cyrus work on a private repository.

**`gh auth status` warns about a missing `read:org` even when your token works
fine.** That warning is informational: `gh` asks for `read:org` for its own
org-listing features. A token with `repo` but no `read:org` clones, commits,
pushes, and queries repositories successfully. Only add it if you need
organization-level queries:

```bash
gh auth refresh -h github.com -s read:org
```

**Fine-grained PATs** use per-resource permissions instead of scopes and are the
least-privilege option. Grant, at minimum, **Contents: read and write** on the
target repositories, plus **Pull requests: read and write** and **Issues: read
and write** if Cyrus should open PRs or comment. Fine-grained tokens report no
scope list, so tools like `gh auth status` cannot introspect them — that is
expected, not a misconfiguration.

### How Cyrus resolves a GitHub token

Scopes only apply to the personal-access-token path. Cyrus resolves a token in
three tiers, and only the last one is scope-based:

1. **Installation token forwarded by the hosted proxy** (cloud mode) — governed
   by **GitHub App permissions**, not scopes.
2. **Self-minted GitHub App installation token** (self-hosted, when
   `GITHUB_APP_ID` / `GITHUB_APP_INSTALLATION_ID` and
   `~/.cyrus/github-app.pem` are configured) — also **GitHub App permissions**.
   The App's permission set (`contents`, `issues`, `pull_requests`,
   `repository_hooks`) is what grants access; there is no `read:org` equivalent
   to add, and org visibility follows where the App is installed.
3. **`GITHUB_TOKEN` environment variable** (fallback) — a **classic or
   fine-grained PAT**, and the only tier the scope table above applies to.

Router-managed container sessions are a separate path: the per-user `GH_TOKEN`
secret (see [Router mode](ROUTER.md)) is a PAT and follows the same scope rules
as tier 3. Check what a stored token actually carries with:

```bash
cyrus router secrets list <email> --check-scopes
```

That command is advisory only — it reports missing scopes and never rejects a
working token, and it never prints token values.

### Verify Setup

```bash
# Check Git config
git config --global user.name
git config --global user.email

# Check GitHub CLI
gh auth status
```

---

## Security Considerations

- **Use a dedicated account** for Cyrus if you want to limit its access
- **Repository access** is determined by your SSH key and GitHub token permissions
- **Review permissions** before adding repositories to Cyrus
- **Audit commits** - Cyrus-authored PRs include a `<!-- generated-by-cyrus -->` marker for traceability
