import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import * as nunjucks from 'nunjucks';
import { glob } from 'glob';

interface ToolConfig {
    project?: {
        name?: string;
        sources?: {
            files?: string[];
            exclude?: string[];
        };
        includes?: {
            searchDirs?: string[];
            exclude?: string[];
        };
        definitions?: string[];
        libraries?: string[];
    };
    toolchain?: {
        pathAndPrefix?: string;
        processType?: string;
        compileOptions?: string[];
        linkOptions?: string[];
    };
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

async function resolveSourceFiles(rootPath: string, patterns: string[]): Promise<string[]> {
    const files = new Set<string>();
    for (let pattern of patterns) {
        // "Lib/*.c" -> "Lib/**/*.c" (递归)
        // "Src/main.c" -> "Src/main.c" (精确)
        if (pattern.includes('/*.')) {
            pattern = pattern.replace(/\/\*\./g, '/**/*.');
        }
        const matches = await glob(pattern, { cwd: rootPath, nodir: true, windowsPathsNoEscape: true });
        matches.forEach(f => files.add(f.replace(/\\/g, '/')));
    }
    return Array.from(files);
}

export async function generateCMakeFromConfig(extensionPath: string): Promise<string> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) throw new Error('未打开工作区');
    
    const rootPath = workspaceFolders[0].uri.fsPath;
    const config = await loadToolConfig(rootPath);

    const includeSearchDirs = await findHeaderDirs(rootPath, config.project?.includes?.searchDirs || []);
    const excludeIncludeDirs = config.project?.includes?.exclude || [];
    const includeDirsFormatted = includeSearchDirs.map(dir => {
        const shouldComment = excludeIncludeDirs.some(exclude => dir.includes(exclude));
        return shouldComment ? `# \${CMAKE_SOURCE_DIR}/${dir}` : `\${CMAKE_SOURCE_DIR}/${dir}`;
    });

    let sourceFiles = await resolveSourceFiles(rootPath, config.project?.sources?.files || []);
    const excludeFiles = await resolveSourceFiles(rootPath, config.project?.sources?.exclude || []);
    sourceFiles = sourceFiles.filter(f => !excludeFiles.includes(f));

    const templatePath = path.join(extensionPath, 'templates', 'CMakeLists.cmake');
    const templateContent = await fs.promises.readFile(templatePath, 'utf8');
    
    const data = {
        projectName: config.project?.name || 'app',
        definitions: config.project?.definitions || [],
        includeDirs: includeDirsFormatted,
        sourceFiles,
        linkLibs: config.project?.libraries || [],
        processType: config.toolchain?.processType,
        toolchainPerfix: config.toolchain?.pathAndPrefix,
        compileOptions: config.toolchain?.compileOptions,
        linkOptions: config.toolchain?.linkOptions
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
