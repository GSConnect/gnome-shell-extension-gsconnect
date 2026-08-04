<!--
SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect

SPDX-License-Identifier: GPL-2.0-or-later
-->

# Private KRdp runtime

GSConnect can optionally package a private `krdpserver`, `libKRdp`, and
KPipeWire runtime. It is disabled by default because the native bundle remains
dependent on the target distribution's Qt, KDE Frameworks, FreeRDP, PipeWire,
and multimedia ABIs.

With sibling source trees in `../kde-connect/{kpipewire,krdp}`, build a ZIP with:

```sh
meson setup _build -Dkrdp_runtime=enabled
ninja -C _build make-zip
```

Override either source tree when configuring Meson:

```sh
meson setup _build \
  -Dkrdp_runtime=enabled \
  -Dkrdp_runtime_kpipewire_source=/path/to/kpipewire \
  -Dkrdp_runtime_krdp_source=/path/to/krdp \
  -Dkrdp_runtime_kf6_min_version=6.24.0
```

The KF6 override is opt-in. Leaving it empty preserves KPipeWire's source-tree
default (currently 6.26.0); use `6.24.0` only for the matching development
environment after validating the required APIs.

The builder can also be used directly:

```sh
build-aux/build-krdp-runtime.sh \
  --kpipewire-source ../kde-connect/kpipewire \
  --krdp-source ../kde-connect/krdp \
  --kf6-min-version 6.24.0 \
  --output _build/runtime/krdp
```

The installed layout is:

```text
runtime/krdp/bin/krdpserver
runtime/krdp/libexec/krdpserver
runtime/krdp/lib/libKRdp.so*
runtime/krdp/lib/libKPipeWire*.so*
```

`bin/krdpserver` is a position-independent launcher. It gives only its child a
private `LD_LIBRARY_PATH`, then replaces itself with the ELF executable in
`libexec`; it never changes the GSConnect service environment. Private ELF
objects use `$ORIGIN`-relative `RUNPATH` entries. The builder rejects absolute
build paths and verifies that KRdp was configured against the private
KPipeWire package.

When the build container and target use different library ABI generations,
additional SONAMEs can be bundled explicitly. Repeat `--bundle-library` with
the direct builder, or set Meson's `krdp_runtime_bundle_libraries` array. The
builder resolves each name in the build environment and verifies that the
finished runtime selects the private copy. This remains target-specific; do
not assume that a native bundle is portable across arbitrary distributions.

For the existing Fedora 43 `devbuild` toolbox and a Fedora 44 host, the bundle
validated for this branch was produced with:

```sh
toolbox run --container devbuild -- \
  ./build-aux/build-krdp-runtime.sh \
  --kpipewire-source ../kde-connect/kpipewire \
  --krdp-source ../kde-connect/krdp \
  --kf6-min-version 6.24.0 \
  --archive _build/gsconnect-krdp-runtime.tar \
  --bundle-library libqt6keychain.so.1 \
  --bundle-library libavcodec.so.61 \
  --bundle-library libavutil.so.59 \
  --bundle-library libavformat.so.61 \
  --bundle-library libavfilter.so.10 \
  --bundle-library libswscale.so.8 \
  --bundle-library libswresample.so.5 \
  --bundle-library libxevdb.so.0 \
  --bundle-library libxeveb.so.0 \
  --bundle-library libbluray.so.2 \
  --bundle-library librabbitmq.so.4 \
  --bundle-library librist.so.4 \
  --bundle-library libpostproc.so.58 \
  --bundle-library libplacebo.so.351 \
  --bundle-library libudfread.so.0
```

Re-run the dependency validation whenever either the toolbox or host is
upgraded. Bundling distribution libraries also requires a separate license
review before publishing the resulting ZIP.

## Portal limitations

The GNOME/xdg-desktop-portal backend negotiates the requested virtual-output
pixel size through KPipeWire. The portal API does not expose KRdp's Plasma
device-pixel-ratio control, however, so the protocol `scale` value is forwarded
for compatibility but does not guarantee a matching compositor UI scale.
Dynamic resizing after the session starts is not supported.
