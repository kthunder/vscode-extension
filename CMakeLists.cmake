cmake_minimum_required(VERSION 3.22)

#
# This file is generated only once,
# and is not re-generated if converter is called multiple times.
#
# User is free to modify the file as much as necessary
#

# Setup compiler settings
set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_C_EXTENSIONS ON)

# Define the build type
if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE "Debug")
endif()

# Set the project name
get_filename_component(PROJECT_DIR ${CMAKE_CURRENT_SOURCE_DIR} NAME) 
set(CMAKE_PROJECT_NAME ${PROJECT_DIR})

###############################################################################
###                  TOOLCHAIN CONFIG                                       ###
###############################################################################
set(CMAKE_SYSTEM_NAME               Generic)
set(CMAKE_SYSTEM_PROCESSOR          {{ processType }})

set(CMAKE_C_COMPILER_FORCED TRUE)
set(CMAKE_CXX_COMPILER_FORCED TRUE)
set(CMAKE_C_COMPILER_ID GNU)
set(CMAKE_CXX_COMPILER_ID GNU)

set(TOOLCHAIN_PATH                  {{ toolchainPath }})
set(TOOLCHAIN_PREFIX                ${TOOLCHAIN_PATH}{{ toolchainPerfix }})

set(CMAKE_C_COMPILER                ${TOOLCHAIN_PREFIX}gcc.exe)
set(CMAKE_CXX_COMPILER              ${TOOLCHAIN_PREFIX}g++.exe)
set(CMAKE_ASM_COMPILER              ${TOOLCHAIN_PREFIX}gcc.exe)
set(CMAKE_LINKER                    ${TOOLCHAIN_PREFIX}ld.exe)
set(CMAKE_OBJCOPY                   ${TOOLCHAIN_PREFIX}objcopy.exe)
set(CMAKE_SIZE                      ${TOOLCHAIN_PREFIX}size.exe)

set(CMAKE_EXECUTABLE_SUFFIX_ASM     ".elf")
set(CMAKE_EXECUTABLE_SUFFIX_C       ".elf")
set(CMAKE_EXECUTABLE_SUFFIX_CXX     ".elf")

set(CMAKE_TRY_COMPILE_TARGET_TYPE STATIC_LIBRARY)

if(CMAKE_BUILD_TYPE MATCHES Debug)
    add_compile_options(-Os -g3)
endif()
if(CMAKE_BUILD_TYPE MATCHES Release)
    add_compile_options(-Os -g0)
endif()

add_compile_options(
{%- for opt in compileOptions %}
    {{ opt }}
{%- endfor %}
)

add_compile_options(
    $<$<COMPILE_LANGUAGE:ASM>:-x$<SEMICOLON>assembler-with-cpp>
)

add_link_options(
{%- for opt in linkOptions %}
    {{ opt }}
{%- endfor %}
)

# Enable compile command to ease indexing with e.g. clangd
set(CMAKE_EXPORT_COMPILE_COMMANDS TRUE)
set(CMAKE_VERBOSE_MAKEFILE OFF)
# 开启彩色诊断输出
add_compile_options(-fdiagnostics-color=always)

# Core project settings
project(${CMAKE_PROJECT_NAME} C CXX ASM)
message("Build type: " ${CMAKE_BUILD_TYPE})

# Enable CMake support for ASM and C languages
enable_language(C ASM)

# Create an executable object type
add_executable(${CMAKE_PROJECT_NAME})

# Link directories setup
target_link_directories(${CMAKE_PROJECT_NAME} PRIVATE
    # Add user defined library search paths
)
###############################################################################
###                  SOURCE FILES                                           ###
###############################################################################

# Add sources to executable
file(GLOB_RECURSE SOURCES
{%- for src in sourceDirs %}
    ${CMAKE_SOURCE_DIR}/{{ src }}/*.[c|s|S]
{%- endfor %}
)
{%- if excludeFiles %}
file(GLOB_RECURSE EXLUDE_FILES
{%- for exc in excludeFiles %}
    ${CMAKE_SOURCE_DIR}/{{ exc }}
{%- endfor %}
)
list(REMOVE_ITEM SOURCES
    ${EXLUDE_FILES}
)
{%- endif %}

target_sources(${CMAKE_PROJECT_NAME} PRIVATE
    # Add user sources here
    ${SOURCES}
)
# Add include paths
target_include_directories(${CMAKE_PROJECT_NAME} PRIVATE
    # Add user defined include paths
{%- for inc in includeDirs %}
    {{ inc }}
{%- endfor %}
)
# Add project symbols (macros)
target_compile_definitions(${CMAKE_PROJECT_NAME} PRIVATE
    # Add user defined symbols
{%- if definitions %}
{%- for def in definitions %}
    {{ def }}
{%- endfor %}
{%- endif %}
    $<$<CONFIG:Debug>:DEBUG>
)

# Add linked libraries
target_link_libraries(${CMAKE_PROJECT_NAME} PRIVATE
    # Add user defined libraries
{%- if linkLibs %}
{%- for lib in linkLibs %}
    {{ lib }}
{%- endfor %}
{%- endif %}
)

###############################################################################
###                  POST BUILD                                             ###
###############################################################################
# Generate output files
set(HEX_FILE ${PROJECT_BINARY_DIR}/${CMAKE_PROJECT_NAME}.hex)
set(BIN_FILE ${PROJECT_BINARY_DIR}/${CMAKE_PROJECT_NAME}.bin)
set(DIS_FILE ${PROJECT_BINARY_DIR}/${CMAKE_PROJECT_NAME}.dis)

# Generate hex, bin and disassembly files
add_custom_command(TARGET ${CMAKE_PROJECT_NAME} POST_BUILD
    COMMAND ${CMAKE_OBJCOPY} -O ihex $<TARGET_FILE:${CMAKE_PROJECT_NAME}> ${HEX_FILE}
    COMMAND ${CMAKE_OBJCOPY} --gap-fill 0xff -O binary $<TARGET_FILE:${CMAKE_PROJECT_NAME}> ${BIN_FILE}
    COMMAND ${CMAKE_OBJDUMP} -d $<TARGET_FILE:${CMAKE_PROJECT_NAME}> > ${DIS_FILE}
    COMMENT "Generating hex, bin and disassembly files"
)

# Print size information
add_custom_command(TARGET ${CMAKE_PROJECT_NAME} POST_BUILD
    COMMAND ${CMAKE_SIZE} $<TARGET_FILE:${CMAKE_PROJECT_NAME}>
    COMMENT "Size information:"
)

# set(TARGET_PLATFORM cw3065)
# add_custom_command(TARGET ${CMAKE_PROJECT_NAME} POST_BUILD
#     COMMAND ${CMAKE_COMMAND} -E copy ${BIN_FILE} ${PROJECT_BINARY_DIR}/../app/script/${TARGET_PLATFORM}/${TARGET_PLATFORM}_sdk.bin
#     COMMAND ${CMAKE_COMMAND} -E env ${PROJECT_BINARY_DIR}/../cw_package_pool/tools/cw_fw_tool.exe ${TARGET_PLATFORM} ${PROJECT_BINARY_DIR}/../app/script/${TARGET_PLATFORM}/config.ini ./ ${PROJECT_BINARY_DIR}/../app/script/${TARGET_PLATFORM}/${TARGET_PLATFORM}_sdk.bin NULL
#     COMMENT "Custom post build step"
# )