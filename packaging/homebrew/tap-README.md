# alperen-selcuk/homebrew-tap

Homebrew tap for [Colima Desktop](https://github.com/alperen-selcuk/colima-desktop) — an independent,
open-source desktop GUI for [Colima](https://github.com/abiosoft/colima) on macOS & Linux.

## Install

```sh
brew tap alperen-selcuk/tap
brew trust --cask alperen-selcuk/tap/colima-desktop
brew install colima-desktop
```

`brew trust` is required by Homebrew 7+, which refuses to load casks from third-party taps until
they're trusted ("Refusing to load cask ... from untrusted tap ..."). Homebrew versions without a
`brew trust` command can skip that step.

Or, in one line without tapping first:

```sh
brew tap alperen-selcuk/tap
brew trust --cask alperen-selcuk/tap/colima-desktop
brew install --cask alperen-selcuk/tap/colima-desktop
```

(Tapping first is still needed even for the "one line" form — `brew trust` and `brew install` both
need the tap to already be known to resolve `alperen-selcuk/tap/colima-desktop`.)

This cask automatically installs the `colima` and `docker` formulae as dependencies. For the
Kubernetes tab, also run `brew install kubectl`.

## Uninstall

```sh
brew uninstall --cask colima-desktop

# Also remove app data/settings (preferences, caches, saved state):
brew uninstall --zap --cask colima-desktop
```

## Cask file

`Casks/colima-desktop.rb` is generated automatically by the
[`homebrew.yml`](https://github.com/alperen-selcuk/colima-desktop/blob/main/.github/workflows/homebrew.yml)
workflow in the main [colima-desktop](https://github.com/alperen-selcuk/colima-desktop) repo, from
[`packaging/homebrew/colima-desktop.rb.tmpl`](https://github.com/alperen-selcuk/colima-desktop/blob/main/packaging/homebrew/colima-desktop.rb.tmpl),
every time a release is published there. **Do not edit it by hand** — manual changes will be
overwritten by the next release.

To change how the cask is built (dependencies, caveats, uninstall/zap paths, etc.), edit the template
in the `colima-desktop` repo instead and cut a new release.

## Issues

Please file issues and feature requests against the
[colima-desktop repo](https://github.com/alperen-selcuk/colima-desktop/issues), not this tap.
