import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import * as nunjucks from 'nunjucks';

interface ToolConfig {
    projectName?: string;
    definitions?: string[];
    sourceSearchDirs?: string[];
    includeSearchDirs?: string[];
    excludeFiles?: string[];
    excludeIncludeDirs?: string[];
    linkLibs?: string[];
    processType?: string[];
    toolchainPath?: string[];
    toolchainPerfix?:string[];
    compileOptions?: string[];
    linkOptions?: string[];
}

async function loadToolConfig(rootPath: string): Promise<ToolConfig> {
    const configPath = path.join(rootPath, '.vscode', 'tools.json');
    try {
        const data = await fs.promises.readFile(configPath, 'utf8');
        return JSON.parse(data);
    } catch {
        return {};
    }
}

async function findHeaderDirs(rootPath: string, searchDirs: string[]): Promise<string[]> {
    const headerDirs = new Set<string>();
    
    async function scanDir(dir: string) {
        try {
            const entries = await fs.promises.readdir(dir, { withFileTypes: true });
            let hasHeader = false;
            
            for (const entry of entries) {
                if (entry.isFile() && entry.name.endsWith('.h')) {
                    hasHeader = true;
                    break;
                }
            }
            
            if (hasHeader) {
                headerDirs.add(path.relative(rootPath, dir).replace(/\\/g, '/'));
            }
            
            for (const entry of entries) {
                if (entry.isDirectory() && !entry.name.startsWith('.')) {
                    await scanDir(path.join(dir, entry.name));
                }
            }
        } catch {}
    }
    
    for (const searchDir of searchDirs) {
        const fullPath = path.join(rootPath, searchDir);
        await scanDir(fullPath);
    }
    
    return Array.from(headerDirs);
}

export async function generateCMakeFromConfig(extensionPath: string): Promise<string> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) throw new Error('未打开工作区');
    
    const rootPath = workspaceFolders[0].uri.fsPath;
    const config = await loadToolConfig(rootPath);

    const includeSearchDirs = await findHeaderDirs(rootPath, config.includeSearchDirs || []);

    // 处理注释：匹配到的路径前加 #
    const excludeIncludeDirs = config.excludeIncludeDirs || [];
    const includeDirsFormatted = includeSearchDirs.map(dir => {
        const shouldComment = excludeIncludeDirs.some(exclude => dir.includes(exclude));
        return shouldComment ? `# \${CMAKE_SOURCE_DIR}/${dir}` : `\${CMAKE_SOURCE_DIR}/${dir}`;
    });


    const templatePath = path.join(extensionPath, 'CMakeLists.cmake');
    const templateContent = await fs.promises.readFile(templatePath, 'utf8');
    
    const data = {
        projectName: config.projectName || 'app',
        definitions: config.definitions || [],
        includeDirs: includeDirsFormatted,
        sourceDirs: config.sourceSearchDirs || [],
        excludeFiles: config.excludeFiles || [],
        linkLibs: config.linkLibs || [],
        processType: config.processType,
        toolchainPath: config.toolchainPath,
        toolchainPerfix: config.toolchainPerfix,
        compileOptions: config.compileOptions,
        linkOptions: config.linkOptions
    };

    return nunjucks.renderString(templateContent, data);
}

export async function writeCMakeFile(content: string) {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) return;
    
    const cmakePath = path.join(workspaceFolders[0].uri.fsPath, 'CMakeLists.txt');
    await fs.promises.writeFile(cmakePath, content, 'utf8');
    vscode.window.showInformationMessage('CMakeLists.txt 已生成');
}
