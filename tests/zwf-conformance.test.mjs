import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {createHash} from 'node:crypto';import {compileZip,inspectZwf,inspectZip} from '../lib/vendor/zwf/format.mjs';
const fixture=new URL('./fixtures/zwf-conformance/',import.meta.url);const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
test('canonical ZWF vendor and fixture provenance are exact and pinned',async()=>{
 const provenance=JSON.parse(await readFile(new URL('../lib/vendor/zwf/PROVENANCE.json',import.meta.url)));
 assert.equal(provenance.commit,'91d9043e28d1a3596c5155a1cc608c87cdbbde9d');
 assert.equal(sha(await readFile(new URL('../lib/vendor/zwf/format.mjs',import.meta.url))),provenance.files['src/format.mjs']);
 assert.equal(sha(await readFile(new URL('../lib/vendor/zwf/LICENSE',import.meta.url))),provenance.files.LICENSE);
 assert.equal(JSON.parse(await readFile(new URL('../package.json',import.meta.url))).dependencies.fflate,'0.8.3');
 const canonical=JSON.parse(await readFile(new URL('PROVENANCE.json',fixture)));
 for(const [name,digest] of Object.entries(canonical.fixture_files_sha256))assert.equal(sha(await readFile(new URL(name,fixture))),digest);
});
test('CLI compiles canonical full paths to byte-identical ZWF2 and verifies them',async()=>{
 const input=await readFile(new URL('input.zip',fixture)),expected=await readFile(new URL('output.zwf',fixture));
 const result=await compileZip(input,{title:'Canonical game'});assert.deepEqual(Buffer.from(result.bytes),expected);
 assert.deepEqual((await inspectZwf(result.bytes)).manifest,JSON.parse(await readFile(new URL('manifest.json',fixture))));
 assert.deepEqual(inspectZip(input).files.map(file=>file.path),['index.html','assets/a/icon.png','assets/b/icon.png']);
});
