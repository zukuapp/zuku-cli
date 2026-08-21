# zuku-cli

Command-line interface for the Shizuku (zuku) Platform.

## Installation

```bash
npm install -g zuku-cli
```

## Usage

```bash
zuku --help
```

## Commands

| Command | Description |
|---------|-------------|
| `zuku create <name>` | Create a new project |
| `zuku validate <path>` | Validate a project manifest |
| `zuku package <path>` | Package project for upload |
| `zuku upload <path>` | Upload package to the platform |

### zuku create

```bash
zuku create my-project
```

Creates a new zuku project directory with the required structure and manifest template.

### zuku validate

```bash
zuku validate ./my-project
```

Validates the project manifest (`jump.manifest.json` or `zuku.manifest.json`) against the schema.

### zuku package

```bash
zuku package ./my-project
```

Packages the project into a .zip file ready for upload.

### zuku upload

```bash
zuku upload ./my-project.zip
```

Uploads the packaged project to the zuku Platform.

## Configuration

Create a `.zukurc` file in your home directory:

```json
{
  "api_base": "https://api.zuzunza.com/v1",
  "token": "your-api-token"
}
```

Or use environment variables:
- `ZUKU_API_BASE` — API base URL
- `ZUKU_TOKEN` — Authentication token

## Development

```bash
# Run CLI locally
node index.mjs --help

# Run tests
npm test
```

## Related Projects

- [shizuku](https://github.com/zukuapp/shizuku) — Platform documentation
- [zuku-api](https://github.com/zukuapp/zuku-api) — API spec & SDK
- [zuku-engine-next2d](https://github.com/zukuapp/zuku-engine-next2d) — Jump game engine

## License

Shizuku Open License (SOL)
