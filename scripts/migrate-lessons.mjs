#!/usr/bin/env node
import { join } from 'node:path';
import { migrateLessonRecords } from '../connect/lessons-store.mjs';

const file = join(process.cwd(), 'runtime', 'dsh-home', 'lessons.json');
const rows = migrateLessonRecords(file);
console.log(JSON.stringify({ migrated: true, total: rows.length, qq: rows.filter((row) => row.channels.includes('qq')).length, douyin: rows.filter((row) => row.channels.includes('douyin')).length }));
