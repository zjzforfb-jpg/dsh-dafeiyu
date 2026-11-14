import {spawnSync} from 'node:child_process';
import {userInfo} from 'node:os';
// Supply an existing environment credential through stdin, never argv or a file.
const key=process.env.MINIMAX_API_KEY?.trim(),account=userInfo().username;
if(process.platform!=='darwin'||!key||!/^[-A-Za-z0-9._]+$/.test(key)||!/^[-A-Za-z0-9._@]+$/.test(account)){
  console.error('无法从当前环境安全保存 MiniMax 凭证。');process.exit(1);
}
const result=spawnSync('/usr/bin/security',['-i'],{input:`add-generic-password -U -a ${account} -s DaFeiYu-MiniMax-API-Key -w ${key}\n`,encoding:'utf8',stdio:['pipe','pipe','pipe'],timeout:15000});
const check=spawnSync('/usr/bin/security',['find-generic-password','-a',account,'-s','DaFeiYu-MiniMax-API-Key','-w'],{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:15000});
if(result.error||check.status!==0||check.stdout.trim()!==key){console.error('MiniMax 钥匙串保存或读取验证未通过。');process.exit(1);}
console.log('MiniMax 凭证已保存到登录钥匙串，读取验证通过。');
