'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const {failure}=require('./settings-store');

async function readSkill(skill) {
    try{
        if(!path.isAbsolute(skill.path) || path.basename(skill.path)!=='SKILL.md')throw Error();
        const resolved=await fs.realpath(skill.path);
        const stat=await fs.stat(resolved);
        if(!stat.isFile() || stat.size>512*1024)throw Error();
        const text=await fs.readFile(resolved,'utf8');
        const frontmatter=text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
        const invocationName=frontmatter?.[1].match(/^name:\s*([^\r\n]+)$/m)?.[1].trim().replace(/^['"]|['"]$/g,'');
        if(!invocationName || invocationName.length>100)throw Error();
        return {...skill,path:resolved,name:skill.name || invocationName,invocationName};
    }catch{throw failure('SKILL_INVALID','无法读取此 Skill，请检查 SKILL.md 路径、名称和文件大小');}
}
module.exports={readSkill};
