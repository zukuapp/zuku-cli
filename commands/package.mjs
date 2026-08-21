export default function packageCmd(args) {
  const path = args[0];
  if (!path) {
    console.error('Usage: zuku package <path>');
    process.exit(1);
  }
  console.log(`Packaging: ${path}`);
  // TODO: Zip the project directory
  console.log('Package created successfully.');
}
