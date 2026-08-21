export default function create(args) {
  const name = args[0];
  if (!name) {
    console.error('Usage: zuku create <name>');
    process.exit(1);
  }
  console.log(`Creating project: ${name}`);
  // TODO: Scaffold project directory with manifest template
  console.log('Project created successfully.');
}
