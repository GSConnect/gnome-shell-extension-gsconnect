#!/usr/bin/env bash

# SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
#
# SPDX-License-Identifier: GPL-2.0-or-later

set -Eeuo pipefail
IFS=$'\n\t'

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly PROJECT_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd -P)"
readonly DEFAULT_KPIPEWIRE_SOURCE='../kde-connect/kpipewire'
readonly DEFAULT_KRDP_SOURCE='../kde-connect/krdp'
readonly DEFAULT_BUILD_ROOT='_build/krdp-runtime-build'
readonly PRIVATE_CMAKE_RUNPATH='$ORIGIN;$ORIGIN/../lib'
readonly PRIVATE_ELF_RUNPATH='$ORIGIN:$ORIGIN/../lib'

declare -a cleanup_paths=()

cleanup() {
    local path

    for path in "${cleanup_paths[@]}"; do
        if [[ -n "${path}" && "${path}" != '/' ]]; then
            rm -rf -- "${path}"
        fi
    done
}

trap cleanup EXIT

usage() {
    cat <<'EOF'
Build or install GSConnect's private KRdp runtime bundle.

Build mode:
  build-aux/build-krdp-runtime.sh [OPTIONS] --output DIRECTORY
  build-aux/build-krdp-runtime.sh [OPTIONS] --archive FILE

Install mode (used by Meson):
  build-aux/build-krdp-runtime.sh --install-archive FILE --destination DIRECTORY

Build options:
  --kpipewire-source DIR  KPipeWire source tree
                          (default: ../kde-connect/kpipewire)
  --krdp-source DIR       KRdp source tree
                          (default: ../kde-connect/krdp)
  --build-root DIR        Incremental CMake build/staging directory
                          (default: _build/krdp-runtime-build)
  --output DIR            Write the unpacked bundle to DIR
  --archive FILE          Write a tar archive containing runtime/krdp
  --build-type TYPE       Release, RelWithDebInfo, Debug, or MinSizeRel
                          (default: RelWithDebInfo)
  --kf6-min-version VER   Explicit KPipeWire KF6/ECM minimum override
                          (default: use the KPipeWire source default)
  --bundle-library NAME   Copy a resolved runtime SONAME into the private lib
                          directory; repeat for target-compatibility libraries
  --jobs N                Parallel build jobs (default: number of CPUs)
  --cmake PROGRAM         CMake executable (default: cmake)
  --generator NAME        Explicit CMake generator
  --plasma-session        Build optional Plasma session support
  --clean                 Recreate the complete build root first
  -h, --help              Show this help

Relative paths are resolved from the GSConnect source directory, not from the
caller's working directory. The base bundle contains krdpserver, libKRdp, and
the private KPipeWire libraries. Explicit --bundle-library entries are added
for target compatibility; all other ABI-compatible dependencies remain system
dependencies.
EOF
}

die() {
    printf 'build-krdp-runtime: %s\n' "$*" >&2
    exit 1
}

require_command() {
    command -v -- "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

resolve_path() {
    local path="$1"

    if [[ "${path}" != /* ]]; then
        path="${PROJECT_ROOT}/${path}"
    fi

    realpath -m -- "${path}"
}

assert_safe_generated_path() {
    local path="$1"
    local label="$2"

    [[ -n "${path}" ]] || die "${label} must not be empty"
    [[ "${path}" != '/' ]] || die "${label} must not be the filesystem root"
    [[ "${path}" != "${PROJECT_ROOT}" ]] || die "${label} must not be the project root"
    [[ "${path}" != "${kpipewire_source}" ]] || die "${label} must not be the KPipeWire source"
    [[ "${path}" != "${krdp_source}" ]] || die "${label} must not be the KRdp source"
    [[ "${kpipewire_source}" != "${path}/"* ]] || die "${label} must not contain the KPipeWire source"
    [[ "${krdp_source}" != "${path}/"* ]] || die "${label} must not contain the KRdp source"
}

install_archive() {
    local archive="$1"
    local destination="$2"
    local install_root
    local install_runtime
    local temporary_root
    local entry

    archive="$(resolve_path "${archive}")"
    [[ -f "${archive}" ]] || die "runtime archive does not exist: ${archive}"

    if [[ "${destination}" == /* ]]; then
        install_root="${DESTDIR:-}${destination}"
    else
        install_root="${destination}"
    fi
    install_root="$(realpath -m -- "${install_root}")"
    [[ "${install_root}" != '/' ]] || die 'refusing to install into the filesystem root'

    while IFS= read -r entry; do
        case "${entry}" in
            runtime/krdp|runtime/krdp/*)
                ;;
            *)
                die "unsafe or unexpected archive entry: ${entry}"
                ;;
        esac

        [[ "${entry}" != *'/../'* && "${entry}" != '../'* && "${entry}" != */.. ]] || \
            die "unsafe archive entry: ${entry}"
    done < <(tar -tf "${archive}")

    install_runtime="${install_root}/runtime"
    install -d -m 0755 -- "${install_runtime}"
    temporary_root="$(mktemp -d "${install_runtime}/.krdp-install.XXXXXX")"
    cleanup_paths+=("${temporary_root}")

    tar -xf "${archive}" -C "${temporary_root}"
    [[ -x "${temporary_root}/runtime/krdp/bin/krdpserver" ]] || \
        die 'archive does not contain an executable runtime/krdp/bin/krdpserver'

    rm -rf -- "${install_runtime}/krdp"
    mv -- "${temporary_root}/runtime/krdp" "${install_runtime}/krdp"

    printf 'Installed private KRdp runtime to %s\n' "${install_runtime}/krdp"
}

kpipewire_source="${DEFAULT_KPIPEWIRE_SOURCE}"
krdp_source="${DEFAULT_KRDP_SOURCE}"
build_root="${DEFAULT_BUILD_ROOT}"
output_directory=''
archive_file=''
install_archive_file=''
install_destination=''
build_type='RelWithDebInfo'
kf6_min_version=''
declare -a bundle_libraries=()
jobs=''
cmake_program='cmake'
generator=''
plasma_session='OFF'
clean_build=false

while (($# > 0)); do
    case "$1" in
        --kpipewire-source)
            (($# >= 2)) || die '--kpipewire-source requires a directory'
            kpipewire_source="$2"
            shift 2
            ;;
        --krdp-source)
            (($# >= 2)) || die '--krdp-source requires a directory'
            krdp_source="$2"
            shift 2
            ;;
        --build-root)
            (($# >= 2)) || die '--build-root requires a directory'
            build_root="$2"
            shift 2
            ;;
        --output)
            (($# >= 2)) || die '--output requires a directory'
            output_directory="$2"
            shift 2
            ;;
        --archive)
            (($# >= 2)) || die '--archive requires a file'
            archive_file="$2"
            shift 2
            ;;
        --install-archive)
            (($# >= 2)) || die '--install-archive requires a file'
            install_archive_file="$2"
            shift 2
            ;;
        --destination)
            (($# >= 2)) || die '--destination requires a directory'
            install_destination="$2"
            shift 2
            ;;
        --build-type)
            (($# >= 2)) || die '--build-type requires a value'
            build_type="$2"
            shift 2
            ;;
        --kf6-min-version)
            (($# >= 2)) || die '--kf6-min-version requires a value'
            kf6_min_version="$2"
            shift 2
            ;;
        --bundle-library)
            (($# >= 2)) || die '--bundle-library requires a SONAME'
            bundle_libraries+=("$2")
            shift 2
            ;;
        --jobs)
            (($# >= 2)) || die '--jobs requires a number'
            jobs="$2"
            shift 2
            ;;
        --cmake)
            (($# >= 2)) || die '--cmake requires a program'
            cmake_program="$2"
            shift 2
            ;;
        --generator)
            (($# >= 2)) || die '--generator requires a name'
            generator="$2"
            shift 2
            ;;
        --plasma-session)
            plasma_session='ON'
            shift
            ;;
        --clean)
            clean_build=true
            shift
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            die "unknown option: $1"
            ;;
    esac
done

require_command realpath
require_command tar

if [[ -n "${install_archive_file}" ]]; then
    [[ -n "${install_destination}" ]] || die '--install-archive requires --destination'
    [[ -z "${output_directory}" && -z "${archive_file}" ]] || \
        die '--install-archive cannot be combined with --output or --archive'
    install_archive "${install_archive_file}" "${install_destination}"
    exit 0
fi

[[ -z "${install_destination}" ]] || die '--destination is valid only with --install-archive'
[[ -n "${output_directory}" || -n "${archive_file}" ]] || die 'specify --output or --archive'
[[ -z "${output_directory}" || -z "${archive_file}" ]] || die 'use only one of --output and --archive'

case "${build_type}" in
    Release|RelWithDebInfo|Debug|MinSizeRel)
        ;;
    *)
        die "unsupported build type: ${build_type}"
        ;;
esac

if [[ -z "${jobs}" ]]; then
    if command -v nproc >/dev/null 2>&1; then
        jobs="$(nproc)"
    else
        jobs=1
    fi
fi
[[ "${jobs}" =~ ^[1-9][0-9]*$ ]] || die '--jobs must be a positive integer'

require_command "${cmake_program}"
require_command readelf
require_command ldd
require_command awk
require_command find
require_command install
require_command cp

kpipewire_source="$(resolve_path "${kpipewire_source}")"
krdp_source="$(resolve_path "${krdp_source}")"
build_root="$(resolve_path "${build_root}")"

[[ -f "${kpipewire_source}/CMakeLists.txt" ]] || die "invalid KPipeWire source: ${kpipewire_source}"
[[ -f "${krdp_source}/CMakeLists.txt" ]] || die "invalid KRdp source: ${krdp_source}"
assert_safe_generated_path "${build_root}" 'build root'

if [[ -n "${output_directory}" ]]; then
    output_directory="$(resolve_path "${output_directory}")"
    assert_safe_generated_path "${output_directory}" 'output directory'
else
    archive_file="$(resolve_path "${archive_file}")"
    [[ "${archive_file}" != '/' ]] || die 'archive path must not be the filesystem root'
fi

if ${clean_build}; then
    rm -rf -- "${build_root}"
fi

readonly KPIPEWIRE_BUILD="${build_root}/kpipewire"
readonly KRDP_BUILD="${build_root}/krdp"
readonly PRIVATE_PREFIX="${build_root}/prefix"
readonly PACKAGE_ROOT="${build_root}/package"
readonly BUNDLE_ROOT="${PACKAGE_ROOT}/runtime/krdp"

install -d -m 0755 -- "${build_root}"
rm -rf -- "${PACKAGE_ROOT}"

declare -a generator_args=()
if [[ -n "${generator}" ]]; then
    generator_args=(-G "${generator}")
fi

declare -a common_cmake_args=(
    "-DCMAKE_BUILD_TYPE=${build_type}"
    "-DCMAKE_INSTALL_PREFIX=${PRIVATE_PREFIX}"
    '-DCMAKE_INSTALL_LIBDIR=lib'
    '-DKDE_INSTALL_LIBDIR=lib'
    '-DKDE_INSTALL_USE_QT_SYS_PATHS=OFF'
    "-DCMAKE_INSTALL_RPATH:STRING=${PRIVATE_CMAKE_RUNPATH}"
    '-DCMAKE_INSTALL_RPATH_USE_LINK_PATH:BOOL=OFF'
    '-DCMAKE_SKIP_INSTALL_RPATH:BOOL=OFF'
    '-DBUILD_TESTING=OFF'
)

declare -a kpipewire_version_args=()
if [[ -n "${kf6_min_version}" ]]; then
    [[ "${kf6_min_version}" =~ ^[0-9]+([.][0-9]+){1,3}$ ]] || \
        die "invalid --kf6-min-version value: ${kf6_min_version}"
    kpipewire_version_args=("-DKF6_MIN_VERSION=${kf6_min_version}")
fi

printf 'Configuring KPipeWire from %s\n' "${kpipewire_source}"
"${cmake_program}" -S "${kpipewire_source}" -B "${KPIPEWIRE_BUILD}" \
    "${generator_args[@]}" "${common_cmake_args[@]}" \
    "${kpipewire_version_args[@]}"
"${cmake_program}" --build "${KPIPEWIRE_BUILD}" --parallel "${jobs}"
"${cmake_program}" --install "${KPIPEWIRE_BUILD}"

readonly KPIPEWIRE_CMAKE_DIR="${PRIVATE_PREFIX}/lib/cmake/KPipeWire"
[[ -f "${KPIPEWIRE_CMAKE_DIR}/KPipeWireConfig.cmake" ]] || \
    die "KPipeWire did not install its CMake package below ${PRIVATE_PREFIX}/lib"

printf 'Configuring KRdp from %s\n' "${krdp_source}"
"${cmake_program}" -S "${krdp_source}" -B "${KRDP_BUILD}" \
    "${generator_args[@]}" "${common_cmake_args[@]}" \
    "-DCMAKE_PREFIX_PATH=${PRIVATE_PREFIX}" \
    "-DKPipeWire_DIR=${KPIPEWIRE_CMAKE_DIR}" \
    '-DBUILD_EXAMPLES=OFF' \
    "-DBUILD_PLASMA_SESSION=${plasma_session}"
"${cmake_program}" --build "${KRDP_BUILD}" --parallel "${jobs}"
"${cmake_program}" --install "${KRDP_BUILD}"

configured_kpipewire_dir="$(sed -n 's/^KPipeWire_DIR:[^=]*=//p' "${KRDP_BUILD}/CMakeCache.txt" | tail -n 1)"
[[ -n "${configured_kpipewire_dir}" ]] || \
    die "KRdp did not record the selected KPipeWire package in its CMake cache"
configured_kpipewire_dir="$(realpath -m -- "${configured_kpipewire_dir}")"
[[ "${configured_kpipewire_dir}" == "${KPIPEWIRE_CMAKE_DIR}" ]] || \
    die "KRdp selected a non-private KPipeWire package: ${configured_kpipewire_dir}"

install -d -m 0755 -- \
    "${BUNDLE_ROOT}/bin" "${BUNDLE_ROOT}/lib" "${BUNDLE_ROOT}/libexec"
install -m 0755 -- \
    "${PRIVATE_PREFIX}/bin/krdpserver" "${BUNDLE_ROOT}/libexec/krdpserver"
install -m 0755 -- \
    "${SCRIPT_DIR}/krdpserver-wrapper.sh" "${BUNDLE_ROOT}/bin/krdpserver"

library_count=0
while IFS= read -r -d '' library; do
    cp -a -- "${library}" "${BUNDLE_ROOT}/lib/"
    ((library_count += 1))
done < <(
    find "${PRIVATE_PREFIX}/lib" -maxdepth 1 \( -type f -o -type l \) \
        \( -name 'libKRdp.so*' -o \
           -name 'libKPipeWire.so*' -o \
           -name 'libKPipeWireDmaBuf.so*' -o \
           -name 'libKPipeWireRecord.so*' \) \
        -print0
)
((library_count >= 8)) || die "private library set is incomplete (${library_count} entries)"

while IFS= read -r -d '' link; do
    link_target="$(readlink -- "${link}")"
    [[ "${link_target}" != /* && "${link_target}" != *'../'* ]] || \
        die "private library symlink escapes the bundle: ${link} -> ${link_target}"
    [[ -e "$(dirname -- "${link}")/${link_target}" ]] || \
        die "broken private library symlink: ${link} -> ${link_target}"
done < <(find "${BUNDLE_ROOT}/lib" -maxdepth 1 -type l -print0)

while IFS= read -r -d '' elf; do
    dynamic_section="$(readelf -d "${elf}")"
    runpath="$(sed -n 's/.*(RUNPATH).*\[\(.*\)\].*/\1/p' <<<"${dynamic_section}")"

    [[ -n "${runpath}" ]] || die "ELF has no RUNPATH: ${elf}"
    if [[ "${runpath}" != "${PRIVATE_ELF_RUNPATH}" ]]; then
        "${cmake_program}" \
            "-DELF_PATH:FILEPATH=${elf}" \
            "-DOLD_RPATH:STRING=${runpath}" \
            "-DNEW_RPATH:STRING=${PRIVATE_ELF_RUNPATH}" \
            -P "${SCRIPT_DIR}/rewrite-elf-rpath.cmake"

        dynamic_section="$(readelf -d "${elf}")"
        runpath="$(sed -n 's/.*(RUNPATH).*\[\(.*\)\].*/\1/p' <<<"${dynamic_section}")"
    fi

    [[ "${runpath}" == "${PRIVATE_ELF_RUNPATH}" ]] || \
        die "ELF RUNPATH rewrite failed: ${elf}: ${runpath}"
    [[ "${runpath}" == *'$ORIGIN'* ]] || die "ELF RUNPATH is not relative: ${elf}: ${runpath}"
    [[ "${runpath}" != *"${build_root}"* && "${runpath}" != *"${PRIVATE_PREFIX}"* ]] || \
        die "ELF RUNPATH leaks a build path: ${elf}: ${runpath}"

    if [[ "${elf}" == */libexec/krdpserver ]]; then
        [[ "${runpath}" == *'$ORIGIN/../lib'* ]] || \
            die "krdpserver cannot locate its private libraries: ${runpath}"
    fi
done < <(find "${BUNDLE_ROOT}/libexec" "${BUNDLE_ROOT}/lib" -maxdepth 1 -type f -print0)

if ((${#bundle_libraries[@]} > 0)); then
    private_library_path="${PRIVATE_PREFIX}/lib"

    if [[ -n "${LD_LIBRARY_PATH:-}" ]]; then
        private_library_path="${private_library_path}:${LD_LIBRARY_PATH}"
    fi

    dependency_map="$(
        LD_LIBRARY_PATH="${private_library_path}" \
            ldd "${PRIVATE_PREFIX}/bin/krdpserver"
    )"

    for dependency in "${bundle_libraries[@]}"; do
        [[ "${dependency}" =~ ^lib[A-Za-z0-9_.+-]+\.so(\.[A-Za-z0-9_.+-]+)+$ ]] || \
            die "invalid bundled library SONAME: ${dependency}"
        [[ ! -e "${BUNDLE_ROOT}/lib/${dependency}" ]] || \
            die "bundled library conflicts with a private library: ${dependency}"

        dependency_path="$(
            awk -v name="${dependency}" \
                '$1 == name && $2 == "=>" && $3 ~ /^\// { print $3; exit }' \
                <<<"${dependency_map}"
        )"
        [[ -f "${dependency_path}" ]] || \
            die "could not resolve bundled library: ${dependency}"

        install -m 0755 -- "${dependency_path}" \
            "${BUNDLE_ROOT}/lib/${dependency}"
    done
fi

bundle_library_path="${BUNDLE_ROOT}/lib"
if [[ -n "${LD_LIBRARY_PATH:-}" ]]; then
    bundle_library_path="${bundle_library_path}:${LD_LIBRARY_PATH}"
fi

bundle_dependencies="$(
    LD_LIBRARY_PATH="${bundle_library_path}" \
        ldd "${BUNDLE_ROOT}/libexec/krdpserver"
)"
[[ "${bundle_dependencies}" != *'not found'* ]] || \
    die "bundle still has unresolved runtime libraries:${bundle_dependencies}"

for dependency in "${bundle_libraries[@]}"; do
    resolved_dependency="$(
        awk -v name="${dependency}" \
            '$1 == name && $2 == "=>" && $3 ~ /^\// { print $3; exit }' \
            <<<"${bundle_dependencies}"
    )"
    [[ "${resolved_dependency}" == "${BUNDLE_ROOT}/lib/${dependency}" ]] || \
        die "bundle did not select its private ${dependency}: ${resolved_dependency}"
done

if [[ -n "${output_directory}" ]]; then
    output_parent="$(dirname -- "${output_directory}")"
    install -d -m 0755 -- "${output_parent}"
    temporary_output="$(mktemp -d "${output_parent}/.krdp-runtime.XXXXXX")"
    cleanup_paths+=("${temporary_output}")
    cp -a -- "${BUNDLE_ROOT}/." "${temporary_output}/"

    rm -rf -- "${output_directory}"
    mv -- "${temporary_output}" "${output_directory}"
    cleanup_paths=()
    printf 'Private KRdp runtime written to %s\n' "${output_directory}"
else
    archive_parent="$(dirname -- "${archive_file}")"
    install -d -m 0755 -- "${archive_parent}"
    temporary_archive="$(mktemp "${archive_parent}/.krdp-runtime.XXXXXX.tar")"
    cleanup_paths+=("${temporary_archive}")

    tar --sort=name --mtime='UTC 1970-01-01' \
        --owner=0 --group=0 --numeric-owner \
        -cf "${temporary_archive}" -C "${PACKAGE_ROOT}" runtime/krdp
    chmod 0644 "${temporary_archive}"
    mv -f -- "${temporary_archive}" "${archive_file}"
    cleanup_paths=()
    printf 'Private KRdp runtime archive written to %s\n' "${archive_file}"
fi
