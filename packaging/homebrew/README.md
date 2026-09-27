# Homebrew tap packaging

This directory holds the template used to generate the Homebrew cask published
to the [`alperen-selcuk/homebrew-tap`](https://github.com/alperen-selcuk/homebrew-tap)
repository.

## Layout

- `colima-desktop.rb.tmpl` — a cask template with placeholders (`__VERSION__`,
  `__SHA256__`, `__URL__`) that get substituted by `.github/workflows/homebrew.yml`
  on every published GitHub Release. The rendered file is committed to the tap
  repo at `Casks/colima-desktop.rb`.

## How it's used

1. A tag `vX.Y.Z` is pushed and `.github/workflows/release.yml` builds and
   publishes a draft GitHub Release with a universal macOS `.dmg` (plus Linux
   packages).
2. Once that release is published (marked non-draft), `.github/workflows/homebrew.yml`
   runs, looks up the `.dmg` asset via `gh release view --json assets`,
   downloads it, computes its `sha256`, and renders this template into
   `Casks/colima-desktop.rb`.
3. That rendered file is committed and pushed to `alperen-selcuk/homebrew-tap`
   using the `HOMEBREW_TAP_TOKEN` secret (a fine-grained PAT scoped to that
   repo only — see `docs/RELEASING.md`).

## Tap repo layout (for reference)

The `alperen-selcuk/homebrew-tap` repository itself only needs:

```
homebrew-tap/
└── Casks/
    └── colima-desktop.rb
```

Once that repo exists and has at least one cask, users can install with:

```sh
brew tap alperen-selcuk/tap
brew install --cask colima-desktop
```

or, without tapping first:

```sh
brew install --cask alperen-selcuk/tap/colima-desktop
```

## Local testing

Render the template by hand and check it with Ruby's syntax checker:

```sh
sed \
  -e "s|__VERSION__|0.1.0|g" \
  -e "s|__SHA256__|0000000000000000000000000000000000000000000000000000000000000000|g" \
  -e "s|__URL__|https://github.com/alperen-selcuk/colima-desktop/releases/download/v0.1.0/Colima.Desktop_0.1.0_universal.dmg|g" \
  packaging/homebrew/colima-desktop.rb.tmpl > /tmp/colima-desktop.rb

ruby -c /tmp/colima-desktop.rb
```
