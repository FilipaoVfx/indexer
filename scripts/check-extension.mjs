import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
const manifest=JSON.parse(fs.readFileSync(new URL('../extension/manifest.json',import.meta.url)));
const files=new Set([manifest.background.service_worker,...manifest.content_scripts.flatMap(s=>s.js), 'popup.js','delivery-store.js']);
for(const file of files){const result=spawnSync(process.execPath,['--check',new URL(`../extension/${file}`,import.meta.url).pathname],{stdio:'inherit'});if(result.status!==0)process.exit(result.status||1);}
if(!manifest.content_scripts.some(s=>s.world==='MAIN'&&s.js.includes('page-bridge.js')&&s.run_at==='document_start'))throw Error('Missing early main-world bridge');
if(manifest.host_permissions.includes('*://*/*'))throw Error('Unrestricted mandatory host permission');
if(!manifest.permissions.includes('unlimitedStorage'))throw Error('Migration and durable capture require unlimitedStorage');
console.log(`Extension ${manifest.version}: manifest and ${files.size} scripts checked`);
