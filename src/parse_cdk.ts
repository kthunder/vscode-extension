import * as fs from 'fs';
import * as xml2js from 'xml2js';
import * as vscode from 'vscode';

let compilerPathMap: { [key: string]: string } = {
    "xPack GNU Arm Embedded GCC Compiler": "\${env:TTS_PATH}/toolchain/xpack-arm-none-eabi-gcc-10.3.1-2.3/bin/arm-none-eabi-gcc.exe",
    "GNU Arm Cross C Compiler": "\${env:TTS_PATH}/toolchain/xpack-arm-none-eabi-gcc-10.3.1-2.3/bin/arm-none-eabi-gcc.exe",
    "LLVMEmbeddedToolchainForArm Compiler": "\${env:TTS_PATH}/toolchain/LLVMEmbeddedToolchainForArm-17.0.1-Windows-x86_64/bin/clang.exe",
    "HighTec Arm llvm Compiler": "\${env:TTS_PATH}/toolchain/HighTec/toolchains/arm/v8.0.0/bin/clang.exe"
};

function findPropertyByName(obj: any, propName: string): any {
    for (const key in obj) {
        if (obj.hasOwnProperty(key)) {
            const value = obj[key];
            let matchId = obj["attributes"];
            if (key === propName) {
                // if (key === propName && typeof value !== 'object') {  
                // 如果找到匹配的属性名且值不是对象，直接返回  
                return value;
            } else if (typeof value === 'object' && value !== null) {
                // 如果值是对象或数组，递归搜索  
                const result = findPropertyByName(value, propName);
                if (result !== undefined) {
                    // 如果递归搜索找到结果，返回结果  
                    return result;
                }
            }
        }
    }
    // 如果没有找到匹配的属性，返回undefined  
    return undefined;
}

async function readTtsProjectConfig() {
    let workspaceFolders = vscode.workspace.workspaceFolders;
    let path = workspaceFolders === undefined ? '' : workspaceFolders[0].uri.fsPath;
    // console.log(path);

    return fs.promises.readFile(path + '/.cproject', 'utf8')
        .then(data => xml2js.parseStringPromise(data, { mergeAttrs: true }))
        .then(res => findPropertyByName(res, "cconfiguration"))
        .then(cconfigurations =>
            cconfigurations.find((item: any) => item.hasOwnProperty("id") && item["id"][0].includes("debug"))["storageModule"]
        )
        .then(cconfiguration => findPropertyByName(cconfiguration, "configuration")[0]);
}

function parseTtsProjectConfig(config: object): {
    toolchain: string,
    ex_list: [string],
    in_list: [string],
    definitions: [string],
    linker_script_file: string
} {
    let c_compiler_config = findPropertyByName(config, "tool").find(
        (item: any) => item.hasOwnProperty('id') && item['id'][0].includes('compiler'));

    let c_linker_config = findPropertyByName(config, "tool").find(
        (item: any) => item.hasOwnProperty('id') && item['id'][0].includes('c.linker'));

    let toolchain: string = findPropertyByName(config, "tool").find(
        (item: any) => item.hasOwnProperty('id') && item['id'][0].includes('tool.c.compiler'))['name'][0];

    let ex_list = findPropertyByName(config, "excluding") ? findPropertyByName(config, "excluding")[0].split('|') : [];
    let in_list = c_compiler_config['option'].find(
        (item: any) => item.hasOwnProperty('id') && item['id'][0].includes('include.paths')
    )['listOptionValue'].map(
        (item: any) => {
            return item['value'][0].match(/src.*}/)[0].replace('}', '');
        }
    );
    let definitions = c_compiler_config['option'].find(
        (item: any) => item.hasOwnProperty('id') && item['id'][0].includes('c.compiler.other')
    )['value'][0].split(' ').map((item: string) => item.replace('-D', ''));
    let linker_script_file = c_linker_config['option'].find(
        (item: any) => item.hasOwnProperty('id') && item['id'][0].includes('c.linker.scriptfile')
    )['listOptionValue'][0]['value'][0].match(/src.*\.ld/)[0];

    return {
        'toolchain': toolchain,
        'ex_list': ex_list,
        'in_list': in_list,
        'definitions': definitions,
        'linker_script_file': linker_script_file
    };
}

async function saveVscodeConfig(config: {
    toolchain: string,
    ex_list: [string],
    in_list: [string],
    definitions: [string],
    linker_script_file: string
}) {
    let workspaceFolders = vscode.workspace.workspaceFolders;
    let path = workspaceFolders === undefined ? '' : workspaceFolders[0].uri.fsPath;

    let doc: vscode.TextDocument;
    let VsConfig: any;


    try {
        doc = await vscode.workspace.openTextDocument(vscode.Uri.file(path + "/.vscode/settings.json"));
        VsConfig = JSON.parse(doc.getText());
    } catch (error) {
        VsConfig = {};
        // cConfig = JSON.parse(template);
    }

    let m = config.ex_list.reduce(
        (map: { [key: string]: boolean }, item: string) => {
            map[item] = true; return map;
        }, {} as { [key: string]: boolean }
    );

    let clangd_arguments = [
        "-j=12",
        "--background-index",
        "--query-driver=C:\\APP\\C-SKY\\CDKRepo\\Toolchain\\XTGccElfNewlib\\V2.10.0\\R\\bin\\riscv64-unknown-elf-*",
        "--compile-commands-dir=${workspaceFolder}/build",
        "--all-scopes-completion",
        "--completion-style=detailed",
        "--header-insertion=never",
        "--clang-tidy",
        "--log=verbose"
    ]

    // VsConfig['files.exclude'] = m;
    VsConfig['clangd.arguments'] = clangd_arguments;
    vscode.workspace.fs.writeFile(vscode.Uri.file(path + "/.vscode/settings.json"), new TextEncoder().encode(JSON.stringify(VsConfig, null, 2)));

    try {
        doc = await vscode.workspace.openTextDocument(vscode.Uri.file(path + "/.vscode/launch.json"));
        VsConfig = JSON.parse(doc.getText());
    } catch (error) {
        const temp = `
        {
            "version": "0.2.0"
        }`;
        VsConfig = JSON.parse(temp);
    }

    let launch_config_template = {
        "name": "cw series launch (cklink)",
        "cwd": "${workspaceRoot}",
        "executable": "./build/${workspaceFolderBasename}.elf",
        // "request": "launch",
        "type": "cortex-debug",
        "servertype": "external",
        "gdbPath": "C:/APP/C-SKY/CDKRepo/Toolchain/XTGccElfNewlib/V2.10.0/R/bin/riscv64-unknown-elf-gdb.exe",
        "gdbTarget": "localhost:1025",
        "runToEntryPoint": "main",
        // "overrideLaunchCommands": [
        //     "set remotetimeout unlimited",
        // ],
        "overrideResetCommands": [
            "monitor reset halt"
        ],
        "overrideRestartCommands": [
            "monitor reset halt"
        ],
        "preLaunchTask": "start debug server",
        "postDebugTask": "stop debug server"
    }

    let launch = {
        "request": "launch",
        "overrideLaunchCommands": [
            "set remotetimeout unlimited",
            // "monitor flash program -f ./cw_package_pool/soc/riscv/cw2225/ROM/cw2225_rom.elf -v", //for FPGA
            // "monitor flash program -f ./build/cw2225_sdk_production.hex",
            "monitor flash program -f ./build/cw2225_sdk_production.bin -b -a 0x1040000",
            "monitor reset halt",
            // "jump Reset_Handler",
        ],
    }

    let attch = {
        "request": "attach",
        "overrideAttachCommands": [],
    }

    VsConfig['configurations'] = [
        { ...launch_config_template, ...launch },
        { ...launch_config_template, ...attch },
    ];
    vscode.workspace.fs.writeFile(vscode.Uri.file(path + "/.vscode/launch.json"), new TextEncoder().encode(JSON.stringify(VsConfig, null, 2)));


    try {
        doc = await vscode.workspace.openTextDocument(vscode.Uri.file(path + "/.vscode/tasks.json"));
        VsConfig = JSON.parse(doc.getText());
    } catch (error) {
        const temp = `
        {
            "version": "2.0.0"
        }`;
        VsConfig = JSON.parse(temp);
    }

    VsConfig['tasks'] = [
        {
            "type": "shell",
            "label": "Make-Build",
            "command": "cmake -S . -B build -G 'MinGW Makefiles' ; cmake --build build -j12",
            "options": {
                "cwd": "${workspaceFolder}"
            },
            "problemMatcher": []
        },
        {
            "type": "shell",
            "label": "ReBuild",
            "command": "cmake --build build --target clean; cmake --build build -j12",
            "options": {
                "cwd": "${workspaceFolder}"
            },
            "problemMatcher": []
        },
        {
            "type": "shell",
            "label": "start debug server",
            "command": "C:/APP/C-SKY/CDKRepo/DebugServer/XT-DebugServer-windows/V5.18.1/R/bin/DebugServerConsole.exe -flash-algorithm ${workspaceFolder}//cw_package_pool//soc//riscv//cw2225//flash_algo//cw2225_flash_algo.elf",
            "options": {
                "cwd": "${workspaceFolder}"
            },
            "isBackground": true,
            "problemMatcher": [],
            "hide": true
        },
        {
            "type": "shell",
            "label": "stop debug server",
            "command": "ps -name DebugServerConsole|Stop-Process",
            "options": {
                "cwd": "${workspaceFolder}"
            },
            "problemMatcher": [],
            "hide": true
        },
    ];
    vscode.workspace.fs.writeFile(vscode.Uri.file(path + "/.vscode/tasks.json"), new TextEncoder().encode(JSON.stringify(VsConfig, null, 2)));
}

export async function parseTTS() {
    try {
        // let ttsConfig = await readTtsProjectConfig();
        // let conf = parseTtsProjectConfig(ttsConfig);
        await saveVscodeConfig({
            'toolchain': "toolchain",
            'ex_list': ["ex_list"],
            'in_list': ["in_list"],
            'definitions': ["definitions"],
            'linker_script_file': "linker_script_file"
        });

        vscode.window.showInformationMessage("Parse succeed!");
        // vscode.window.showInformationMessage(conf.toolchain);
    } catch (error) {
        // console.log(error);

        vscode.window.showInformationMessage("Parse failed!");
    }
}