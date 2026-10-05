# Releasing Guide (maintainers) / Yayınlama Kılavuzu (bakımcılar için)

## Türkçe

### 1. Homebrew tap deposunu oluşturma (bir kere)

Ayrı, herkese açık bir depo oluşturun — adı tam olarak **`homebrew-tap`** olmalı (Homebrew tap adlandırma
kuralı budur):

```
alperen-selcuk/homebrew-tap
```

İçeriği `.github/workflows/homebrew.yml` tarafından otomatik olarak yönetilecek (`Casks/colima-desktop.rb`).
Depoyu oluştururken tek satır bir `README.md` yeterlidir; ilk cask dosyasını elle eklemenize gerek yok,
ilk `homebrew.yml` çalışması onu oluşturacak. Bkz. `packaging/homebrew/README.md`.

### 2. HOMEBREW_TAP_TOKEN secret'ını oluşturma

1. GitHub → Settings → Developer settings → **Fine-grained personal access tokens** → Generate new token.
2. **Resource owner**: `alperen-selcuk`.
3. **Repository access**: "Only select repositories" → yalnızca `homebrew-tap` seçin (başka hiçbir depoya
   erişimi olmasın).
4. **Permissions** → Repository permissions → **Contents: Read and write**. Başka hiçbir izin gerekmez.
5. Token'ı oluşturun ve kopyalayın.
6. `colima-desktop` deposunda: Settings → Secrets and variables → Actions → New repository secret →
   isim `HOMEBREW_TAP_TOKEN`, değer az önce oluşturduğunuz token.

Bu secret olmadan `homebrew.yml` sessizce bir `::warning::` yazıp başarıyla sonlanır (release akışını
bozmaz); yani tap'i istediğiniz zaman kurabilirsiniz.

### 3. Yeni bir sürüm yayınlama

```sh
git tag v0.2.0
git push origin v0.2.0
```

Bu, `.github/workflows/release.yml`'i tetikler:

- macOS: universal (arm64+x86_64) `.dmg`/`.app`.
- Linux (x86_64 ve aarch64): `.deb`, `.rpm`, `.AppImage`.

Workflow taslak (draft) bir GitHub Release oluşturur. Release sayfasına gidin, üretilen paketleri
inceleyin/test edin, release notlarını (CHANGELOG.md bağlantısı zaten ekli) gözden geçirin, ardından
**Publish release** butonuna basın.

Release yayınlanır yayınlanmaz `.github/workflows/homebrew.yml` otomatik tetiklenir: universal `.dmg`'yi
bulur, sha256'sını hesaplar, `packaging/homebrew/colima-desktop.rb.tmpl`'i doldurur ve
`alperen-selcuk/homebrew-tap` deposuna `Casks/colima-desktop.rb` olarak commit'ler. Birkaç dakika içinde:

```sh
brew update
brew trust --cask alperen-selcuk/tap/colima-desktop   # zaten tap'lediyseniz ve ilk kurulumdan sonra genelde gerekmez
brew install colima-desktop
```

çalışır hale gelir. (`brew trust`, yalnızca ilk kez tap'lenen/kurulan bir cask için ya da Homebrew 7'nin
"untrusted tap" hatasını verdiği durumlarda gereklidir; bkz. `docs/INSTALL.md`.)

Belirli bir tag için manuel tetiklemek isterseniz: Actions → "Update Homebrew Cask" → Run workflow →
`tag` alanına `v0.2.0` girin.

### 4. (İsteğe bağlı) Apple Developer ID imzalama/notarization

`release.yml`, aşağıdaki secret'lar `colima-desktop` deposunda tanımlıysa (özellikle `APPLE_CERTIFICATE`
boş değilse) macOS derlemesini otomatik olarak imzalar ve notarize eder:

| Secret | Açıklama |
|---|---|
| `APPLE_CERTIFICATE` | Developer ID Application sertifikası, base64 kodlu `.p12` |
| `APPLE_CERTIFICATE_PASSWORD` | `.p12` şifresi |
| `APPLE_SIGNING_IDENTITY` | Örn. `Developer ID Application: Ad Soyad (TEAMID)` |
| `APPLE_ID` | Apple ID e-postası (notarization için) |
| `APPLE_PASSWORD` | Bu Apple ID için app-specific password |
| `APPLE_TEAM_ID` | 10 haneli Apple Developer Team ID |

Bunlar tanımlı değilse derleme imzasız/notarize edilmemiş şekilde devam eder (mevcut davranış); kullanıcılar
Gatekeeper uyarısını `xattr -dr com.apple.quarantine` ile temizler (bkz. [docs/INSTALL.md](INSTALL.md)).

### 5. Resmi `homebrew/homebrew-cask`'e girme (uzun vadeli, isteğe bağlı)

Şu an kullanıcılar `brew tap alperen-selcuk/tap`, ardından `brew trust --cask alperen-selcuk/tap/colima-desktop`
(Homebrew 7+ için) ve `brew install colima-desktop` komutlarıyla kurulum yapıyor. Uygulamanın resmi
Homebrew cask deposuna (`homebrew/homebrew-cask`) kabul edilip düz `brew install colima-desktop`'ın (tap
ve trust adımı gerekmeden) çalışabilmesi için:

- **İmzalama zorunlu**: Homebrew, cask'lerin Gatekeeper'ı geçmesini (Apple Developer ID ile imzalı ve
  notarize edilmiş olmasını) şart koşar. Yukarıdaki §4'teki secret'lar kalıcı olarak yapılandırılmalı.
- **Proje "notability" (bilinirlik) kriterleri**: Homebrew, resmi cask deposuna kabul için projenin
  yeterince kullanıldığına/bilindiğine dair kanıt ister (yeterli yıldız/fork/kullanım sayısı gibi);
  kendi projesini gönderen (self-submitted) projeler için bu eşik daha yüksek tutulur. Güncel eşikleri
  başvurmadan önce [Homebrew'in cask kabul kriterleri dokümantasyonından](https://docs.brew.sh/Adding-Software-to-Homebrew)
  kontrol edin — burada kesin bir sayı vermiyoruz çünkü zamanla değişebiliyor.
- Kriterler sağlandığında `brew bump-cask-pr` (veya elle bir PR) ile `homebrew/homebrew-cask` deposuna
  başvuru yapılır.

Bu adım tamamlanana kadar kişisel tap (`alperen-selcuk/tap`) tam olarak çalışır ve önerilen kurulum
yöntemidir.

---

## English

### 1. Create the Homebrew tap repository (one-time)

Create a separate, public repository — it must be named exactly **`homebrew-tap`** (this is Homebrew's
tap naming convention):

```
alperen-selcuk/homebrew-tap
```

Its contents will be managed automatically by `.github/workflows/homebrew.yml` (`Casks/colima-desktop.rb`).
A one-line `README.md` is enough when creating it — you don't need to add the first cask file by hand,
the first `homebrew.yml` run will create it. See `packaging/homebrew/README.md`.

### 2. Create the HOMEBREW_TAP_TOKEN secret

1. GitHub → Settings → Developer settings → **Fine-grained personal access tokens** → Generate new token.
2. **Resource owner**: `alperen-selcuk`.
3. **Repository access**: "Only select repositories" → select only `homebrew-tap` (it should have no
   access to any other repository).
4. **Permissions** → Repository permissions → **Contents: Read and write**. No other permission is needed.
5. Generate the token and copy it.
6. On the `colima-desktop` repo: Settings → Secrets and variables → Actions → New repository secret →
   name it `HOMEBREW_TAP_TOKEN`, value is the token you just created.

Without this secret, `homebrew.yml` silently prints a `::warning::` and exits successfully (it will not
break the release flow), so you can wire up the tap whenever you're ready.

### 3. Publishing a new release

```sh
git tag v0.2.0
git push origin v0.2.0
```

This triggers `.github/workflows/release.yml`:

- macOS: a universal (arm64+x86_64) `.dmg`/`.app`.
- Linux (x86_64 and aarch64): `.deb`, `.rpm`, `.AppImage`.

The workflow creates a **draft** GitHub Release. Go to the release page, review/test the generated
packages, check the release notes (a CHANGELOG.md link is already included), then click
**Publish release**.

As soon as the release is published, `.github/workflows/homebrew.yml` fires automatically: it locates the
universal `.dmg`, computes its sha256, renders `packaging/homebrew/colima-desktop.rb.tmpl`, and commits it
to the `alperen-selcuk/homebrew-tap` repo as `Casks/colima-desktop.rb`. Within a few minutes:

```sh
brew update
brew trust --cask alperen-selcuk/tap/colima-desktop   # usually only needed once, per tap/cask
brew install colima-desktop
```

will work. (`brew trust` is needed the first time you tap/install this cask on Homebrew 7+, which
refuses to load casks from untrusted third-party taps until trusted; see `docs/INSTALL.md`.)

To trigger it manually for a specific tag: Actions → "Update Homebrew Cask" → Run workflow → enter
`v0.2.0` in the `tag` field.

### 4. (Optional) Apple Developer ID signing/notarization

`release.yml` will automatically sign and notarize the macOS build if the following secrets are set on
the `colima-desktop` repo (specifically, whenever `APPLE_CERTIFICATE` is non-empty):

| Secret | Description |
|---|---|
| `APPLE_CERTIFICATE` | Developer ID Application certificate, base64-encoded `.p12` |
| `APPLE_CERTIFICATE_PASSWORD` | Password for the `.p12` |
| `APPLE_SIGNING_IDENTITY` | e.g. `Developer ID Application: Your Name (TEAMID)` |
| `APPLE_ID` | Apple ID email (used for notarization) |
| `APPLE_PASSWORD` | An app-specific password for that Apple ID |
| `APPLE_TEAM_ID` | Your 10-character Apple Developer Team ID |

Without them, builds continue unsigned/unnotarized (current behavior); users clear the Gatekeeper warning
with `xattr -dr com.apple.quarantine` (see [docs/INSTALL.md](INSTALL.md)).

### 5. Getting into the official `homebrew/homebrew-cask` (long-term, optional)

Right now users install via `brew tap alperen-selcuk/tap`, then `brew trust --cask
alperen-selcuk/tap/colima-desktop` (on Homebrew 7+) and `brew install colima-desktop`. For the app to be
accepted into Homebrew's official cask repository (`homebrew/homebrew-cask`), so that plain
`brew install colima-desktop` works without tapping or trusting first:

- **Signing is required**: Homebrew requires casks to pass Gatekeeper (i.e. be signed with an Apple
  Developer ID and notarized). The secrets from §4 above need to be permanently configured.
- **Project notability requirements**: Homebrew requires evidence that the project is sufficiently used
  and known (sufficient stars/forks/usage) before accepting it into the official cask repo;
  self-submitted projects face higher thresholds than well-established ones. Check the current criteria
  in [Homebrew's own "Adding Software to Homebrew" documentation](https://docs.brew.sh/Adding-Software-to-Homebrew)
  before applying — we deliberately don't quote an exact number here since it can change over time.
- Once the criteria are met, submit via `brew bump-cask-pr` (or a manual PR) against
  `homebrew/homebrew-cask`.

Until that step is done, the personal tap (`alperen-selcuk/tap`) is fully functional and is the
recommended install method.
