import * as fs from 'fs';
import * as xml2js from 'xml2js';
import * as vscode from 'vscode';
function extractFiles(obj: any): string[] {
    const files: string[] = [];
    
    function traverse(node: any) {
        // 如果当前节点有 ExcludeProjConfig="BuildSet"，跳过
        if (node.ExcludeProjConfig === "BuildSet") {
            return;
        }
        
        if (node.File) {
            if (Array.isArray(node.File)) {
                files.push(...node.File
                    .filter((f: any) => f.ExcludeProjConfig !== "BuildSet") // 过滤文件级别的排除
                    .map((f: any) => f.Name)
                    .filter((name: string) => 
                        name.endsWith('.c') || name.endsWith('.S') || name.endsWith('.s')
                    )
                );
            } else {
                // 检查单个文件的 ExcludeProjConfig 属性
                if (node.File.ExcludeProjConfig !== "BuildSet" && 
                    (node.File.Name.endsWith('.c') || node.File.Name.endsWith('.S') || node.File.Name.endsWith('.s'))) {
                    files.push(node.File.Name);
                }
            }
        }
        
        if (node.VirtualDirectory) {
            const dirs = Array.isArray(node.VirtualDirectory) ? node.VirtualDirectory : [node.VirtualDirectory];
            dirs.forEach(traverse);
        }
    }
    
    if (Array.isArray(obj)) {
        obj.forEach(traverse);
    } else {
        traverse(obj);
    }
    
    return files;
}

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

    return fs.promises.readFile(path + '/proj/cw3065/cw3065_ws/cw3065_sdk/cw3065_sdk.cdkproj', 'utf8')
        .then(data => xml2js.parseStringPromise(data, { mergeAttrs: true, explicitArray: false }))
        .then((res: any) => findPropertyByName(res, "Project"))
}

function parseTtsProjectConfig(config: object): {
    // toolchain: string,
    fileList: string[],
    in_list: string[],
    definitions: string[],
    linker_script_file: string
} {
    // console.log(config);
    let BuildConfig = findPropertyByName(config, "BuildConfig")
    let Compiler = findPropertyByName(BuildConfig, "Compiler")
    let Linker = findPropertyByName(BuildConfig, "Linker")

    let in_list = Compiler['IncludePath'].split(';').filter((path:any) => path.trim());
    // console.log(in_list);
    let definitions: string[] = [Compiler["Define"]]
    let linker_script_file: string = Linker["LDFile"]

    let fileList: string[] = extractFiles((config as any)['VirtualDirectory'])
        .map((file: string) => `$(ProjectPath)/${file}`);
    // console.log();
    console.log('VirtualDirectory:', JSON.stringify((config as any)['VirtualDirectory'], null, 2));
    console.log(fileList);

    return {
        // 'toolchain': toolchain,
        // 'ex_list': ex_list,
        'fileList': fileList,
        'in_list': in_list,
        'definitions': definitions,
        'linker_script_file': linker_script_file
    };
}

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
function fillCMakeTemplate(conf: any): string {
    // 处理路径，$(ProjectPath) 是 cw3065_sdk.cdkproj 所在位置
    // 需要转换为相对于工作区根目录的路径
    const processPath = (path: string) => path.replace('$(ProjectPath)', '${CMAKE_SOURCE_DIR}/proj/cw3065/cw3065_ws/cw3065_sdk');
    
    const includes = conf.in_list
        .map(processPath)
        .map((path: string) => `    ${path}`)
        .join('\n');
    
    const sources = conf.fileList
        .map(processPath)
        .map((path: string) => `    ${path}`)
        .join('\n');
    
    const definitions = conf.definitions.join('\n    ');
    
    return `set(CMAKE_RUNTIME_OUTPUT_DIRECTORY \${CMAKE_BINARY_DIR})

target_compile_definitions(\${CMAKE_PROJECT_NAME} PRIVATE 
    ${definitions}
    $<$<CONFIG:Debug>:DEBUG>
)

target_include_directories(\${CMAKE_PROJECT_NAME} PRIVATE
${includes}
)

target_sources(\${CMAKE_PROJECT_NAME} PRIVATE
${sources}
)

target_link_directories(\${CMAKE_PROJECT_NAME} PRIVATE
)

target_link_libraries(\${CMAKE_PROJECT_NAME} PUBLIC
    # rtt-kernel
)

# Validate that cw3065 code is compatible with C standard
if(CMAKE_C_STANDARD LESS 11)
    message(ERROR "Generated code requires C11 or higher")
endif()

target_link_options(\${CMAKE_PROJECT_NAME} PRIVATE
    -T ${processPath(conf.linker_script_file)}
    -T \${CMAKE_SOURCE_DIR}/cw_package_pool/soc/riscv/cw3065/ROM/cw3065_rom_symbol.txt
)`;
}

async function writeCMakeFile(content: string) {
    let workspaceFolders = vscode.workspace.workspaceFolders;
    let path = workspaceFolders === undefined ? '' : workspaceFolders[0].uri.fsPath;
    let uri = vscode.Uri.file(path + '/.cmake/cw3065_test/CMakeLists.txt');
    
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content));
}
export async function parseTTS() {
    try {
        let ttsConfig = await readTtsProjectConfig();
        // console.log(ttsConfig);
        // let fileList = extractFiles(ttsConfig['VirtualDirectory']);
        let conf = parseTtsProjectConfig(ttsConfig);
        let cmakeContent = fillCMakeTemplate(conf);
        await writeCMakeFile(cmakeContent);
        // await updateVscodeConfig();
        console.log('conf:', JSON.stringify(conf, null, 2));
        vscode.window.showInformationMessage("Parse succeed!");
        // vscode.window.showInformationMessage(conf.toolchain);
    } catch (error) {
        console.log(error);
        vscode.window.showInformationMessage("Parse failed!");
    }
}