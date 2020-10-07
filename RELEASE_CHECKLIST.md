# Release Checklist

## Preparing for a new release

- [ ] Bump version in `meson.build`
- [ ] Bump version in `data/metainfo/org.gnome.Shell.Extensions.GSConnect.metainfo.xml.in`
- [ ] Run `meson _build`
- [ ] Run `meson test -C _build`
- [ ] Make a commit and push it

## Release: Github

- [ ] Run `meson _build`
- [ ] Run `ninja -C _build make-zip`
- [ ] Tag a new release with notes at `https://github.com/andyholmes/gnome-shell-extension-gsconnect/releases/new`
- [ ] Add `_build/gsconnect@andyholmes.github.io.zip` to the release

## Release: EGO

- [ ] Run `meson _build`
- [ ] Run `ninja -C _build make-zip`
- [ ] Upload `_build/gsconnect@andyholmes.github.io.zip` to `https://extensions.gnome.org/upload`

