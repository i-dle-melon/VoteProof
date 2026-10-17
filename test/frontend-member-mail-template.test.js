import test from 'node:test';
import assert from 'node:assert/strict';
import {supportMailTemplate} from '../public/js/admin-member-contact.js';

test('formal support template uses the resolved nickname, fan ID and existing explanation exactly',()=>{
 assert.deepEqual(supportMailTemplate({nickname:'葉子',fan_id:'fan_yeh',explanation:'第一行說明\n第二行說明'}),{
  subject:'VoteProof 會員通知',
  body:'您好 葉子，\n\n這是 VoteProof 管理團隊寄出的會員通知。\n\n粉絲 ID：fan_yeh\n\n通知內容：\n第一行說明\n第二行說明\n\n如有任何問題，可直接回覆此郵件與我們聯絡。\n\nVoteProof 管理團隊',
 });
});
test('missing nickname has exactly 您好， and missing explanation leaves the content area blank',()=>{
 for(const nickname of [undefined,null,'','   ']){
  const template=supportMailTemplate({nickname,fan_id:'resolved_fan'});
  assert.equal(template.body.split('\n')[0],'您好，');
  assert.ok(template.body.includes('通知內容：\n\n\n如有任何問題'));
  assert.doesNotMatch(template.body,/undefined|null|\{\{(?:nickname_suffix|fan_id|message)\}\}/);
 }
});
test('each template uses only that resolved member and keeps supplied text literal',()=>{
 const first={nickname:'第一位',fan_id:'first_fan',explanation:'第一位說明'};
 const second={nickname:'<b>第二位</b>',fan_id:'second_fan',explanation:'純文字 $&\n下一行'};
 supportMailTemplate(first);const template=supportMailTemplate(second);
 assert.ok(template.body.startsWith('您好 <b>第二位</b>，\n'));
 assert.ok(template.body.includes('粉絲 ID：second_fan'));
 assert.ok(template.body.includes('純文字 $&\n下一行'));
 assert.doesNotMatch(template.body,/第一位|first_fan/);
 assert.deepEqual(second,{nickname:'<b>第二位</b>',fan_id:'second_fan',explanation:'純文字 $&\n下一行'});
});
