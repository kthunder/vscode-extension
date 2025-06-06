import * as vscode from 'vscode';

async function editJsonFile(config_file_name: string, content: object, template: string) {
    let workspaceFolders = vscode.workspace.workspaceFolders;
    let path = workspaceFolders === undefined ? '' : workspaceFolders[0].uri.fsPath;
    let uri = vscode.Uri.file(path + `/.vscode/${config_file_name}.json`)

    let doc: vscode.TextDocument;
    let defaultConfig: any;

    try {
        doc = await vscode.workspace.openTextDocument(uri);
        defaultConfig = JSON.parse(doc.getText());
    } catch (error) {
        defaultConfig = JSON.parse(template);
    }

    let s = { ...defaultConfig, ...content };
    vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(JSON.stringify(s, null, 2)));
}

async function updateVscodeConfig() {
    let VsConfig: any;

    VsConfig["clangd_arguments"] = [
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

    editJsonFile("settings", VsConfig, "{}");

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
        // "preLaunchCommands": [
        //     "monitor flash program -f ./cw_package_pool/soc/riscv/cw2225/ROM/cw2225_rom.elf -v",
        // ],
        "preLaunchTask": "start debug server",
        "postDebugTask": "stop debug server"
    }

    let launch = {
        "request": "launch",
        "preLaunchCommands": [
            "set remotetimeout unlimited",
            "monitor flash program -f ./cw_package_pool/soc/riscv/cw2225/ROM/cw2225_rom.elf",
            "monitor flash program -f ./build/cw2225_sdk_for_dbg.bin -b -a 0x1040000",
        ],
    }

    let attch = {
        "request": "attach",
    }

    VsConfig['configurations'] = [
        { ...launch_config_template, ...launch },
        { ...launch_config_template, ...attch },
    ];

    editJsonFile("launch", VsConfig, `{"version": "0.2.0"}`);

    VsConfig = null
    VsConfig['tasks'] = [
        {
            "type": "shell",
            "label": "start cklink debug server",
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
            "label": "stop cklink debug server",
            "command": "Stop-Process -Name 'DebugServerConsole' -Force",
            "options": {
                "cwd": "${workspaceFolder}"
            },
            "problemMatcher": [],
            "hide": true
        },
    ];

    editJsonFile("tasks", VsConfig, `{"version": "2.0.0"}`);
}

export async function parseTTS() {
    try {
        await updateVscodeConfig();
        vscode.window.showInformationMessage("Parse succeed!");
        // vscode.window.showInformationMessage(conf.toolchain);
    } catch (error) {
        // console.log(error);
        vscode.window.showInformationMessage("Parse failed!");
    }
}