export default function upload(args) {
  const path = args[0];
  if (!path) {
    console.error('Usage: zuku upload <path>');
    process.exit(1);
  }
  console.log(`Uploading: ${path}`);
  // TODO: Upload to zuku API
  console.log('Upload completed successfully.');
}
