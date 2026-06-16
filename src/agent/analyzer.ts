import * as vscode from "vscode";
import * as path from "path";

export interface RepositoryProfile {
  language: string;
  framework?: string;
  packageManager?: string;
  buildCommand?: string;
  testCommand?: string;
  lintCommand?: string;
}

export async function analyzeRepository(): Promise<RepositoryProfile> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!root) {
    return { language: "Unknown" };
  }

  // Find all config files in the root folder to be fast
  const files = await vscode.workspace.findFiles(
    "{package.json,tsconfig.json,go.mod,requirements.txt,pyproject.toml,Cargo.toml,pom.xml,build.gradle,*.sln,*.csproj,index.html}",
    "**/node_modules/**",
    10
  );

  const filenames = files.map(f => path.basename(f.fsPath));
  const profile: RepositoryProfile = { language: "Unknown" };

  // 1. Rust
  if (filenames.includes("Cargo.toml")) {
    profile.language = "Rust";
    profile.packageManager = "cargo";
    profile.buildCommand = "cargo build";
    profile.testCommand = "cargo test";
    return profile;
  }

  // 2. Go
  if (filenames.includes("go.mod")) {
    profile.language = "Go";
    profile.packageManager = "go mod";
    profile.buildCommand = "go build ./...";
    profile.testCommand = "go test ./...";

    // Detect framework in go.mod
    try {
      const uri = files.find(f => f.fsPath.endsWith("go.mod"));
      if (uri) {
        const bytes = await vscode.workspace.fs.readFile(uri);
        const text = new TextDecoder().decode(bytes);
        if (text.includes("github.com/gin-gonic/gin")) {
          profile.framework = "Gin";
        } else if (text.includes("github.com/astaxie/beego")) {
          profile.framework = "Beego";
        } else if (text.includes("github.com/labstack/echo")) {
          profile.framework = "Echo";
        }
      }
    } catch {
      // ignore
    }
    return profile;
  }

  // 3. TypeScript / JavaScript
  if (filenames.includes("package.json")) {
    profile.language = filenames.includes("tsconfig.json") ? "TypeScript" : "JavaScript";
    profile.buildCommand = "npm run build";
    profile.testCommand = "npm run test";
    profile.packageManager = "npm";

    // Detect package lock / package manager
    const locks = await vscode.workspace.findFiles(
      "{package-lock.json,yarn.lock,pnpm-lock.yaml}",
      "**/node_modules/**",
      3
    );
    const lockNames = locks.map(l => path.basename(l.fsPath));
    if (lockNames.includes("pnpm-lock.yaml")) {
      profile.packageManager = "pnpm";
      profile.buildCommand = "pnpm run build";
      profile.testCommand = "pnpm run test";
    } else if (lockNames.includes("yarn.lock")) {
      profile.packageManager = "yarn";
      profile.buildCommand = "yarn run build";
      profile.testCommand = "yarn run test";
    }

    // Read package.json for script configs and frameworks
    try {
      const uri = files.find(f => f.fsPath.endsWith("package.json"));
      if (uri) {
        const bytes = await vscode.workspace.fs.readFile(uri);
        const pkg = JSON.parse(new TextDecoder().decode(bytes));
        
        // Framework detection
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        if (deps["react"]) {
          profile.framework = "React";
        } else if (deps["next"]) {
          profile.framework = "Next.js";
        } else if (deps["vue"]) {
          profile.framework = "Vue";
        } else if (deps["@angular/core"]) {
          profile.framework = "Angular";
        }

        // Script configuration
        if (pkg.scripts) {
          const pm = profile.packageManager;
          if (pkg.scripts.build) {
            profile.buildCommand = `${pm} run build`;
          } else if (profile.language === "TypeScript") {
            profile.buildCommand = "npx tsc --noEmit";
          }
          
          if (pkg.scripts.test) {
            profile.testCommand = `${pm} run test`;
          }
          if (pkg.scripts.lint) {
            profile.lintCommand = `${pm} run lint`;
          }
        }
      }
    } catch {
      // ignore
    }
    return profile;
  }

  // 4. Python
  if (filenames.includes("pyproject.toml") || filenames.includes("requirements.txt")) {
    profile.language = "Python";
    profile.packageManager = filenames.includes("pyproject.toml") ? "poetry" : "pip";
    profile.testCommand = "pytest";

    // Read pyproject.toml / requirements.txt for framework detection
    try {
      const pyprojectUri = files.find(f => f.fsPath.endsWith("pyproject.toml"));
      const reqsUri = files.find(f => f.fsPath.endsWith("requirements.txt"));
      
      let text = "";
      if (pyprojectUri) {
        const bytes = await vscode.workspace.fs.readFile(pyprojectUri);
        text = new TextDecoder().decode(bytes);
      } else if (reqsUri) {
        const bytes = await vscode.workspace.fs.readFile(reqsUri);
        text = new TextDecoder().decode(bytes);
      }

      if (text.includes("django") || text.includes("Django")) {
        profile.framework = "Django";
      } else if (text.includes("flask") || text.includes("Flask")) {
        profile.framework = "Flask";
      } else if (text.includes("fastapi") || text.includes("FastAPI")) {
        profile.framework = "FastAPI";
      }
    } catch {
      // ignore
    }
    return profile;
  }

  // 5. Java
  if (filenames.includes("pom.xml") || filenames.includes("build.gradle")) {
    profile.language = "Java";
    if (filenames.includes("pom.xml")) {
      profile.packageManager = "maven";
      profile.buildCommand = "mvn package";
      profile.testCommand = "mvn test";
    } else {
      profile.packageManager = "gradle";
      profile.buildCommand = "gradle build";
      profile.testCommand = "gradle test";
    }
    return profile;
  }

  // 6. .NET
  const hasCsproj = filenames.some(f => f.endsWith(".csproj"));
  const hasSln = filenames.some(f => f.endsWith(".sln"));
  if (hasCsproj || hasSln) {
    profile.language = "C#";
    profile.packageManager = "nuget";
    profile.buildCommand = "dotnet build";
    profile.testCommand = "dotnet test";
    return profile;
  }

  // 7. Static Website / HTML
  if (filenames.includes("index.html")) {
    profile.language = "HTML";
    profile.framework = "Static Website";
    return profile;
  }

  return profile;
}
