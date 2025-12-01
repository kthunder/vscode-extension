import * as fs from 'fs';
import * as xml2js from 'xml2js';
import * as vscode from 'vscode';

let compilerPathMap: { [key: string]: string } = {
    "xPack GNU Arm Embedded GCC Compiler": "\${env:TTS_PATH}/toolchain/xpack-arm-none-eabi-gcc-10.3.1-2.3/bin/arm-none-eabi-gcc.exe",
    "GNU Arm Cross C Compiler": "\${env:TTS_PATH}/toolchain/xpack-arm-none-eabi-gcc-10.3.1-2.3/bin/arm-none-eabi-gcc.exe",
    "LLVMEmbeddedToolchainForArm Compiler": "\${env:TTS_PATH}/toolchain/LLVMEmbeddedToolchainForArm-17.0.1-Windows-x86_64/bin/clang.exe",
    "HighTec Arm llvm Compiler": "\${env:TTS_PATH}/toolchain/HighTec/toolchains/arm/v8.0.0/bin/clang.exe"
};
let intelliSenseModeMap: { [key: string]: string } = {
    "xPack GNU Arm Embedded GCC Compiler": "gcc-arm",
    "GNU Arm Cross C Compiler": "gcc-arm",
    "LLVMEmbeddedToolchainForArm Compiler": "clang-arm",
    "HighTec Arm llvm Compiler": "clang-arm"
};

const template = `
{
    "configurations": [
        {
            "name": "Alioth series",
            "includePath": [],
            "defines": [],
            "forcedInclude": [],
            "compilerPath": "\${env:TTS_PATH}/toolchain/xpack-arm-none-eabi-gcc-10.3.1-2.3/bin/arm-none-eabi-gcc.exe",
            "cStandard": "c99",
            "intelliSenseMode": "gcc-arm",
            "configurationProvider": "ms-vscode.make-tools"
        }
    ],
    "version": 4
}
`;

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
    let cConfig: any;
    let VsConfig: any;

    try {
        doc = await vscode.workspace.openTextDocument(vscode.Uri.file(path + "/.vscode/c_cpp_properties.json"));
        cConfig = JSON.parse(doc.getText());
    } catch (error) {
        cConfig = JSON.parse(template);
    }

    cConfig["configurations"][0]['includePath'] = config.in_list;
    cConfig["configurations"][0]['defines'] = config.definitions;
    cConfig["configurations"][0]['compilerPath'] = compilerPathMap[config.toolchain];
    cConfig["configurations"][0]['intelliSenseMode'] = intelliSenseModeMap[config.toolchain];
    vscode.workspace.fs.writeFile(vscode.Uri.file(path + "/.vscode/c_cpp_properties.json"), new TextEncoder().encode(JSON.stringify(cConfig, null, 2)));

    try {
        doc = await vscode.workspace.openTextDocument(vscode.Uri.file(path + "/.vscode/settings.json"));
        VsConfig = JSON.parse(doc.getText());
    } catch (error) {
        VsConfig = {};
    }

    let m = config.ex_list.reduce(
        (map: { [key: string]: boolean }, item: string) => {
            map[item] = true; return map;
        }, {} as { [key: string]: boolean }
    );

    VsConfig['files.exclude'] = m;
    vscode.workspace.fs.writeFile(vscode.Uri.file(path + "/.vscode/settings.json"), new TextEncoder().encode(JSON.stringify(VsConfig, null, 2)));
}

export async function parseTTS() {
    try {
        let ttsConfig = await readTtsProjectConfig();
        let conf = parseTtsProjectConfig(ttsConfig);
        await saveVscodeConfig(conf);

        vscode.window.showInformationMessage("Parse succeed!");
        vscode.window.showInformationMessage(conf.toolchain);
    } catch (error) {
        // console.log(error);

        vscode.window.showInformationMessage("Parse failed!");
    }
}