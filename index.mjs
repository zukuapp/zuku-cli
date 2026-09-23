#!/usr/bin/env node

const args = process.argv.slice(2);
const command = args[0];

switch (command) {
  case 'create':
    import('./commands/create.mjs').then(m => m.default(args.slice(1)));
    break;
  case 'validate':
    import('./commands/validate.mjs').then(m => m.default(args.slice(1)));
    break;
  case 'package':
    import('./commands/package.mjs').then(m => m.default(args.slice(1)));
    break;
  case 'upload':
    import('./commands/upload.mjs').then(m => m.default(args.slice(1)));
    break;
  case '--help':
  case '-h':
  case undefined:
    showHelp();
    break;
  default:
    console.error(`Unknown command: ${command}`);
    console.error('Run "zuku --help" for usage.');
    process.exit(1);
}

function showHelp() {
  console.log(`
zuku CLI — Shizuku Platform command-line interface

Usage:
  zuku <command> [options]

Commands:
  create   <name>     Create a new project
  validate <path>     Validate a project manifest
  package  <path>     Package project for upload
  upload   <path>     Upload package to the platform

Options:
  --help, -h          Show this help message

Examples:
  zuku create my-project
  zuku validate ./my-project
  zuku package ./my-project
  zuku upload ./my-project.zip

For more information:
  https://github.com/zukuapp/zuku-cli
`);
}
