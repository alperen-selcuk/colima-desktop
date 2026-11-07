# Security Policy

## Supported versions

Only the latest release of Colima Desktop receives security fixes. Please upgrade
(`brew upgrade --cask colima-desktop` or re-run the installer) before reporting.

## Reporting a vulnerability

Please **do not open a public issue** for security problems.

Report privately through GitHub:
**Security → Report a vulnerability** on
<https://github.com/alperen-selcuk/colima-desktop/security/advisories/new>.

Include the version, OS, steps to reproduce and the impact you observed. You can
expect an acknowledgement within a few days; fixes ship as a patch release and are
credited in the advisory unless you prefer otherwise.

## Scope

Colima Desktop is a local GUI that shells out to `colima`, `docker` and `kubectl`.
Of particular interest:

- command or argument injection into those CLIs
- anything that touches a kubeconfig context other than the app's own `colima*` contexts
- exposure of Kubernetes Secret values or Marketplace credentials
- the install script (`scripts/install.sh`) and release/Homebrew pipeline

Vulnerabilities in Colima, Docker, Kubernetes or Lima themselves should be reported
to those projects.
