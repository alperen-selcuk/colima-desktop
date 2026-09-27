# Installation Guide / Kurulum Kılavuzu

## Türkçe

### Homebrew (macOS)

```sh
brew tap alperen-selcuk/tap
brew trust --cask alperen-selcuk/tap/colima-desktop
brew install colima-desktop
```

(Homebrew 7'den itibaren üçüncü parti tap'lerden gelen cask'ler `brew trust` ile onaylanana kadar
yüklenmeyi reddeder — "Refusing to load cask ... from untrusted tap" hatası alırsanız bu adımı
çalıştırın. Bu komutu desteklemeyen daha eski Homebrew sürümlerinde bu adımı atlayabilirsiniz.)

Ya da tap'i önceden eklemeden tek satırda:

```sh
brew tap alperen-selcuk/tap
brew trust --cask alperen-selcuk/tap/colima-desktop
brew install --cask alperen-selcuk/tap/colima-desktop
```

Bu cask `colima` ve `docker` bağımlılıklarını otomatik olarak kurar. Kubernetes sekmesi için ayrıca
`brew install kubectl` çalıştırmanız gerekir.

### Kurulum betiği (Linux ve macOS)

```sh
curl -fsSL https://raw.githubusercontent.com/alperen-selcuk/colima-desktop/main/scripts/install.sh | bash
```

Betik işletim sisteminizi ve mimarinizi (x86_64/aarch64) otomatik algılar:

- **Linux**: `apt` tabanlı sistemlerde `.deb`, `dnf`/`yum`/`zypper` tabanlı sistemlerde `.rpm`, diğerlerinde
  (veya `--appimage` bayrağıyla zorlandığında) taşınabilir bir `.AppImage` kurar. AppImage kurulumunda
  ikili dosya `~/.local/bin/colima-desktop`'a, masaüstü kısayolu `~/.local/share/applications/`'a kopyalanır.
- **macOS**: Homebrew varsa yukarıdaki `brew` komutunu önerir, ama yine de doğrudan `.dmg` indirip
  `/Applications`'a kurabilir.

Faydalı seçenekler:

```sh
# Belirli bir sürüm
curl -fsSL .../install.sh | bash -s -- --version v0.1.0

# Linux'ta paket yöneticisini atlayıp AppImage zorla
curl -fsSL .../install.sh | bash -s -- --appimage

# Kaldırma
curl -fsSL .../install.sh | bash -s -- --uninstall
```

### Manuel indirme

[GitHub Releases](https://github.com/alperen-selcuk/colima-desktop/releases) sayfasından işletim
sisteminize uygun paketi indirin: macOS için `.dmg` (universal, Intel + Apple Silicon), Linux için
`.deb`/`.rpm`/`.AppImage`.

### İmzasız macOS derlemeleri hakkında not

Şu an için macOS paketleri Apple Developer ID ile imzalanmamış/notarize edilmemiştir (bkz.
[docs/RELEASING.md](RELEASING.md)). Uygulamayı ilk açtığınızda Gatekeeper "zarar verebilir" uyarısı
verirse, karantina niteliğini terminalden kaldırın:

```sh
xattr -dr com.apple.quarantine "/Applications/Colima Desktop.app"
```

Homebrew cask'i kullanıyorsanız bu adım kurulum sırasında otomatik olarak yapılır.

### Gereksinimler

- [colima](https://github.com/abiosoft/colima) (PATH üzerinde) — uygulamanın çalıştırdığı motor.
- `docker` CLI (PATH üzerinde).
- `kubectl` (isteğe bağlı, Kubernetes sekmesi için).

### Kaldırma

```sh
# Homebrew ile kurulduysa
brew uninstall --cask colima-desktop
brew uninstall --zap --cask colima-desktop   # ayarları da temizler

# install.sh ile kurulduysa
curl -fsSL https://raw.githubusercontent.com/alperen-selcuk/colima-desktop/main/scripts/install.sh | bash -s -- --uninstall
```

---

## English

### Homebrew (macOS)

```sh
brew tap alperen-selcuk/tap
brew trust --cask alperen-selcuk/tap/colima-desktop
brew install colima-desktop
```

(Starting with Homebrew 7, casks from third-party taps are refused until trusted with `brew trust` —
if you see "Refusing to load cask ... from untrusted tap", run that step. Older Homebrew versions
without a `brew trust` command can skip it.)

Or, without tapping first:

```sh
brew tap alperen-selcuk/tap
brew trust --cask alperen-selcuk/tap/colima-desktop
brew install --cask alperen-selcuk/tap/colima-desktop
```

This cask automatically installs the `colima` and `docker` dependencies. For the Kubernetes tab, also
run `brew install kubectl`.

### Install script (Linux and macOS)

```sh
curl -fsSL https://raw.githubusercontent.com/alperen-selcuk/colima-desktop/main/scripts/install.sh | bash
```

The script auto-detects your OS and architecture (x86_64/aarch64):

- **Linux**: installs a `.deb` on `apt`-based systems, a `.rpm` on `dnf`/`yum`/`zypper`-based systems, and
  a portable `.AppImage` otherwise (or when forced with `--appimage`). The AppImage install copies the
  binary to `~/.local/bin/colima-desktop` and a desktop shortcut to `~/.local/share/applications/`.
- **macOS**: suggests the `brew` command above if Homebrew is present, but can still install directly by
  downloading the `.dmg` and copying the app into `/Applications`.

Useful options:

```sh
# Install a specific version
curl -fsSL .../install.sh | bash -s -- --version v0.1.0

# Force the AppImage on Linux, skipping the system package manager
curl -fsSL .../install.sh | bash -s -- --appimage

# Uninstall
curl -fsSL .../install.sh | bash -s -- --uninstall
```

### Manual download

Grab the package for your platform from [GitHub Releases](https://github.com/alperen-selcuk/colima-desktop/releases):
a universal (Intel + Apple Silicon) `.dmg` for macOS, and `.deb`/`.rpm`/`.AppImage` for Linux.

### A note on unsigned macOS builds

macOS packages are currently not signed or notarized with an Apple Developer ID (see
[docs/RELEASING.md](RELEASING.md)). If Gatekeeper blocks the app with a "damaged" or "unidentified
developer" warning on first launch, clear the quarantine attribute:

```sh
xattr -dr com.apple.quarantine "/Applications/Colima Desktop.app"
```

This is done automatically for you when installing via the Homebrew cask.

### Requirements

- [colima](https://github.com/abiosoft/colima) on your `PATH` — the engine the app drives.
- `docker` CLI on your `PATH`.
- `kubectl` (optional, for the Kubernetes tab).

### Uninstall

```sh
# If installed via Homebrew
brew uninstall --cask colima-desktop
brew uninstall --zap --cask colima-desktop   # also removes app data/settings

# If installed via install.sh
curl -fsSL https://raw.githubusercontent.com/alperen-selcuk/colima-desktop/main/scripts/install.sh | bash -s -- --uninstall
```
