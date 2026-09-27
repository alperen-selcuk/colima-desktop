# Homebrew tap packaging

This directory holds the template used to generate the Homebrew cask published
to the [`alperen-selcuk/homebrew-tap`](https://github.com/alperen-selcuk/homebrew-tap)
repository.

## Layout

- `colima-desktop.rb.tmpl` — a cask template with placeholders (`__VERSION__`,
  `__SHA256__`) that get substituted by `.github/workflows/homebrew.yml` on
  every published GitHub Release. The download `url` is not a placeholder —
  it's rendered ruby that interpolates the cask's own `#{version}`, e.g.
  `.../releases/download/v#{version}/Colima.Desktop_#{version}_universal.dmg` —
  so `brew audit` recognizes it as a versioned URL (`sha256 :no_check` is only
  needed for unversioned URLs). The workflow still discovers the actual `.dmg`
  asset via `gh release view --json assets`, but it fails the build with a
  clear `::error::` if that asset's name doesn't match the pattern the
  template assumes, so the cask can never silently point at a 404. The
  rendered file is committed to the tap repo at `Casks/colima-desktop.rb`.
- `tap-README.md` — the README published as-is to the root of the
  `alperen-selcuk/homebrew-tap` repo itself (install/uninstall instructions
  for that repo's users). Edit it here, not in the tap repo.

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
brew trust --cask alperen-selcuk/tap/colima-desktop
brew install colima-desktop
```

(`brew trust` is only needed on Homebrew versions that gate third-party taps
behind it — see docs/INSTALL.md.)

or, in one line (tapping is still required first so `brew trust`/`brew install`
can resolve the fully-qualified name):

```sh
brew tap alperen-selcuk/tap
brew trust --cask alperen-selcuk/tap/colima-desktop
brew install --cask alperen-selcuk/tap/colima-desktop
```

## Local testing

Render the template by hand and check it with Ruby's syntax checker:

```sh
sed \
  -e "s|__VERSION__|0.1.0|g" \
  -e "s|__SHA256__|0000000000000000000000000000000000000000000000000000000000000000|g" \
  packaging/homebrew/colima-desktop.rb.tmpl > /tmp/colima-desktop.rb

ruby -c /tmp/colima-desktop.rb
```

To fully validate against Homebrew's cask linters, copy the rendered file into
your local tap checkout (`$(brew --repo alperen-selcuk/tap)/Casks/colima-desktop.rb`)
and run:

```sh
brew audit --cask --online --strict alperen-selcuk/tap/colima-desktop
brew style --cask alperen-selcuk/tap/colima-desktop
```
