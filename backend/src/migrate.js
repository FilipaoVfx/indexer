import { createClient } from '@supabase/supabase-js';
import fs from 'node:fs/promises';
import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Please set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in your .env file');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

async function migrate() {
  const dataPath = path.join(process.cwd(), 'data', 'bookmarks.json');
  
  try {
    const rawData = await fs.readFile(dataPath, 'utf8');
    const { bookmarks } = JSON.parse(rawData);
    
    console.log(`Starting migration of ${bookmarks.length} bookmarks...`);
    
    // Chunking to avoid large request issues
    const CHUNK_SIZE = 100;
    for (let i = 0; i < bookmarks.length; i += CHUNK_SIZE) {
      const chunk = bookmarks.slice(i, i + CHUNK_SIZE);
      
      const { error } = await supabase
        .from('bookmarks')
        .upsert(chunk, { onConflict: 'id' });
        
      if (error) {
        console.error(`Error migrating chunk starting at index ${i}:`, error);
      } else {
        console.log(`Successfully migrated chunk ${i / CHUNK_SIZE + 1} / ${Math.ceil(bookmarks.length / CHUNK_SIZE)}`);
      }
    }
    
    console.log('Migration completed!');
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

migrate();
