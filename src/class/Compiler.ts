import Project, * as ts from "ts-simple-ast";
import { CompilerError } from "./errors/CompilerError";
import { TranspilerError } from "./errors/TranspilerError";
import { Transpiler } from "./Transpiler";

import * as fs from "fs-extra";
import * as path from "path";

const INCLUDE_SRC_PATH = path.resolve(__dirname, "..", "..", "include");
const SYNC_FILE_NAMES = ["rojo.json", "rofresh.json"];

interface RojoJson {
	partitions: {
		[index: string]: {
			target: string;
			path: string;
		};
	};
}

interface Partition {
	dir: ts.Directory;
	target: string;
}

function red(s: string) {
	return `\x1b[31m${s}\x1b[0m`;
}

const luaIdentifierRegex = /^[A-Za-z_][A-Za-z0-9_]*$/;
function isValidLuaIdentifier(id: string) {
	return luaIdentifierRegex.test(id);
}

function stripExts(fileName: string): string {
	const ext = path.extname(fileName);
	if (ext.length > 0) {
		return stripExts(path.basename(fileName, ext));
	} else {
		return fileName;
	}
}

const moduleCache = new Map<string, string>();

export class Compiler {
	private readonly project: Project;
	private readonly projectPath: string;
	private readonly includePath: string;
	private readonly rootDir: string;
	private readonly outDir: string;
	private readonly modulesDir?: ts.Directory;
	private readonly compilerOptions: ts.CompilerOptions;
	private readonly syncInfo = new Array<Partition>();

	constructor(configFilePath: string, includePath: string) {
		this.projectPath = path.resolve(configFilePath, "..");
		this.project = new Project({
			tsConfigFilePath: configFilePath,
		});
		this.project.addExistingSourceFiles("**/*.d.ts");
		this.includePath = path.resolve(includePath);
		this.compilerOptions = this.project.getCompilerOptions();

		const rootDir = this.compilerOptions.rootDir;
		if (!rootDir) {
			throw new CompilerError("Expected 'rootDir' option in tsconfig.json!");
		}
		this.rootDir = rootDir;

		const outDir = this.compilerOptions.outDir;
		if (!outDir) {
			throw new CompilerError("Expected 'outDir' option in tsconfig.json!");
		}
		this.outDir = outDir;

		this.modulesDir = this.project.getDirectory("node_modules");

		const syncFilePath = this.getSyncFilePath();
		if (syncFilePath) {
			const rojoJson = JSON.parse(fs.readFileSync(syncFilePath).toString()) as RojoJson;
			for (const key in rojoJson.partitions) {
				const part = rojoJson.partitions[key];
				const partPath = path.resolve(part.path).replace(/\\/g, "/");
				if (partPath.startsWith(this.outDir)) {
					const directory = this.project.getDirectory(
						path.resolve(this.rootDir, path.relative(this.outDir, partPath)),
					);
					if (directory) {
						this.syncInfo.push({
							dir: directory,
							target: part.target,
						});
					} else {
						throw new CompilerError(`Could not find directory for partition: ${JSON.stringify(part)}`);
					}
				}
			}
		}
	}

	private getSyncFilePath() {
		for (const name of SYNC_FILE_NAMES) {
			const filePath = path.resolve(this.projectPath, name);
			if (fs.existsSync(filePath)) {
				return filePath;
			}
		}
	}

	private transformPathToLua(rootDir: string, outDir: string, filePath: string) {
		const relativeToRoot = path.dirname(path.relative(rootDir, filePath));
		let name = path.basename(filePath, path.extname(filePath));
		if (this.compilerOptions.module === ts.ModuleKind.CommonJS && name === "index") {
			name = "init";
		}
		const luaName = name + ".lua";
		return path.join(outDir, relativeToRoot, luaName);
	}

	private transformPathToTS(rootDir: string, outDir: string, filePath: string) {
		const relativeToOut = path.dirname(path.relative(outDir, filePath));
		let name = path.basename(filePath, path.extname(filePath));
		if (this.compilerOptions.module === ts.ModuleKind.CommonJS && name === "init") {
			name = "index";
		}
		const luaName = name + ".ts";
		return path.join(rootDir, relativeToOut, luaName);
	}

	public addFile(filePath: string) {
		this.project.addExistingSourceFile(filePath);
	}

	public removeFile(filePath: string) {
		const sourceFile = this.project.getSourceFile(filePath);
		if (sourceFile) {
			this.project.removeSourceFile(sourceFile);
		}
	}

	public refresh(): Promise<Array<ts.FileSystemRefreshResult>> {
		return Promise.all(this.project.getSourceFiles().map(sourceFile => sourceFile.refreshFromFileSystem()));
	}

	public cleanDirRecursive(dir: string) {
		if (fs.existsSync(dir)) {
			const contents = fs.readdirSync(dir);
			for (const name of contents) {
				const filePath = path.join(dir, name);
				if (fs.statSync(filePath).isDirectory()) {
					this.cleanDirRecursive(filePath);
					if (fs.readdirSync(filePath).length === 0) {
						fs.rmdirSync(filePath);
					}
				} else {
					const ext = path.extname(filePath);
					if (ext === ".lua") {
						const tsPath = this.transformPathToTS(this.rootDir, this.outDir, filePath);
						const tsxPath = tsPath + "x";
						if (!this.project.getSourceFile(tsPath) && !this.project.getSourceFile(tsxPath)) {
							fs.removeSync(filePath);
						}
					}
				}
			}
		}
	}

	public getRootDirOrThrow() {
		if (!this.rootDir) {
			throw new CompilerError("Could not find rootDir!");
		}
		return this.rootDir;
	}

	public async compileAll(noInclude: boolean) {
		this.compileFiles(this.project.getSourceFiles(), noInclude);
	}

	public async compileFileByPath(filePath: string, noInclude: boolean) {
		const sourceFile = this.project.getSourceFile(filePath);
		if (!sourceFile) {
			throw new CompilerError(`No SourceFile for Compiler.compileFileByPath() (filePath = ${filePath})`);
		}

		const seen = new Set<string>();
		const files = new Array<ts.SourceFile>();

		const search = (file: ts.SourceFile) => {
			files.push(file);
			file.getReferencingSourceFiles().forEach(ref => {
				const refPath = ref.getFilePath();
				if (!seen.has(refPath)) {
					seen.add(refPath);
					search(ref);
				}
			});
		};
		search(sourceFile);

		return this.compileFiles(files, noInclude);
	}

	public async compileFiles(files: Array<ts.SourceFile>, noInclude: boolean) {
		this.cleanDirRecursive(this.outDir);
		if (this.compilerOptions.declaration === true) {
			this.project.emit({ emitOnlyDtsFiles: true });
		}

		try {
			files
				.filter(sourceFile => !sourceFile.isDeclarationFile())
				.map(sourceFile => {
					const transpiler = new Transpiler(this);
					return [
						this.transformPathToLua(this.rootDir, this.outDir, sourceFile.getFilePath()),
						transpiler.transpileSourceFile(sourceFile),
					];
				})
				.forEach(([filePath, contents]) => ts.ts.sys.writeFile(filePath, contents));
		} catch (e) {
			if (e instanceof TranspilerError) {
				console.log(
					"%s:%d:%d",
					e.node.getSourceFile().getFilePath(),
					e.node.getStartLineNumber(),
					e.node.getNonWhitespaceStart() - e.node.getStartLinePos(),
				);
				console.log(`${red("Transpiler Error:")} ${e.message}`);
			} else if (e instanceof CompilerError) {
				console.log(`${red("Compiler Error:")} ${e.message}`);
			} else {
				throw e;
			}
			process.exitCode = 1;
		}

		if (!noInclude) {
			try {
				await fs.copy(INCLUDE_SRC_PATH, this.includePath);
			} catch (e) {
				// this rarely fails, unsure why
			}
		}
	}

	public getRelativeImportPath(specifier: string) {
		const parts = specifier
			.split("/")
			.filter(part => part !== ".")
			.map(part => (part === ".." ? "Parent" : part))
			.map(part => (isValidLuaIdentifier(part) ? "." + part : `["${part}"]`));
		if (this.compilerOptions.module === ts.ModuleKind.CommonJS && parts[parts.length - 1] === ".index") {
			parts.pop();
		}
		return "script.Parent" + parts.join("");
	}

	public getImportPathFromFile(file: ts.SourceFile) {
		if (this.modulesDir && this.modulesDir.isAncestorOf(file)) {
			let parts = this.modulesDir
				.getRelativePathTo(file)
				.split("/")
				.filter(part => part !== ".");

			const moduleName = parts.shift();
			if (!moduleName) {
				throw new CompilerError("Compiler.getImportPath() failed! #1");
			}

			let mainPath: string;
			if (moduleCache.has(moduleName)) {
				mainPath = moduleCache.get(moduleName)!;
			} else {
				const pkgJson = require(path.join(this.modulesDir.getPath(), moduleName, "package.json"));
				mainPath = pkgJson.main as string;
				moduleCache.set(moduleName, mainPath);
			}

			parts = mainPath.split(/[\\/]/g);
			let last = parts.pop();
			if (!last) {
				throw new CompilerError("Compiler.getImportPath() failed! #2");
			}
			last = stripExts(last);
			if (this.compilerOptions.module !== ts.ModuleKind.CommonJS || last !== "index") {
				parts.push(last);
			}

			parts = parts
				.filter(part => part !== ".")
				.map(part => (isValidLuaIdentifier(part) ? "." + part : `["${part}"]`));

			return `TS.getModule("${moduleName}")` + parts.join("");
		} else {
			const partition = this.syncInfo.find(part => part.dir.isAncestorOf(file));
			if (!partition) {
				throw new CompilerError("Could not compile non-relative import, no data from rojo.json");
			}

			let parts = partition.dir
				.getRelativePathAsModuleSpecifierTo(file)
				.split("/")
				.filter(part => part !== ".");

			const last = parts.pop();
			if (!last) {
				throw new CompilerError("Compiler.getImportPath() failed! #3");
			}

			if (this.compilerOptions.module !== ts.ModuleKind.CommonJS || last !== "index") {
				parts.push(last);
			}

			parts = parts.map(part => (isValidLuaIdentifier(part) ? "." + part : `["${part}"]`));

			return ["game", partition.target].filter(v => v.length > 0).join(".") + parts.join("");
		}
	}
}
