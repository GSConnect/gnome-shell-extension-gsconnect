# SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
#
# SPDX-License-Identifier: GPL-2.0-or-later

cmake_minimum_required(VERSION 3.16)

foreach(required_variable ELF_PATH OLD_RPATH NEW_RPATH)
    if(NOT DEFINED ${required_variable} OR "${${required_variable}}" STREQUAL "")
        message(FATAL_ERROR "Missing required variable: ${required_variable}")
    endif()
endforeach()

if(NOT EXISTS "${ELF_PATH}")
    message(FATAL_ERROR "ELF file does not exist: ${ELF_PATH}")
endif()

file(RPATH_CHANGE
    FILE "${ELF_PATH}"
    OLD_RPATH "${OLD_RPATH}"
    NEW_RPATH "${NEW_RPATH}"
)
