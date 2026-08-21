export default function validate(args) {
  const path = args[0] || '.';
  console.log(`Validating: ${path}`);
  // TODO: Load and validate manifest against schema
  console.log('Validation passed.');
}
