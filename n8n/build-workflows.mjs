// Generates the six importable n8n workflows in n8n/workflows/. Run: node n8n/build-workflows.mjs
// The workflows are thin: schedules and API calls with n8n's stored credentials.
// All the logic lives in the render worker (http://render-worker:8080).
import fs from 'node:fs';
import crypto from 'node:crypto';

const W = 'http://render-worker:8080';
const uid = (s) => crypto.createHash('md5').update(s).digest('hex').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12}).*/, '$1-$2-$3-$4-$5');
const wid = (s) => crypto.createHash('md5').update(s).digest('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 16);
const retry = { retryOnFail: true, maxTries: 3, waitBetweenTries: 5000 };

function node(wf, name, type, typeVersion, position, parameters, extra = {}) {
  return { id: uid(`${wf}:${name}`), name, type, typeVersion, position, parameters, ...extra };
}
const schedule = (wf, name, cron, pos) => node(wf, name, 'n8n-nodes-base.scheduleTrigger', 1.2, pos, { rule: { interval: [{ field: 'cronExpression', expression: cron }] } });
const code = (wf, name, pos, jsCode, mode) => node(wf, name, 'n8n-nodes-base.code', 2, pos, { ...(mode ? { mode } : {}), jsCode });
const manual = (wf, pos) => node(wf, 'Run manually', 'n8n-nodes-base.manualTrigger', 1, pos, {});
const post = (wf, name, url, pos, body, extra = {}) => node(wf, name, 'n8n-nodes-base.httpRequest', 4.2, pos, {
  method: 'POST', url,
  ...(body ? { sendBody: true, specifyBody: 'json', jsonBody: body } : {}),
  options: { timeout: 60000 },
}, { ...retry, ...extra });
// HTML, not n8n's default Markdown: in Markdown an error like "EAI_AGAIN" opens an italic that never
// closes, Telegram refuses the message ("can't parse entities") and the alert is lost.
// Dynamic text goes through esc() so <, > and & can't break it either.
const telegram = (wf, name, text, pos) => node(wf, name, 'n8n-nodes-base.telegram', 1.2, pos, {
  chatId: '={{ $env.TELEGRAM_CHAT_ID }}', text, additionalFields: { appendAttribution: false, parse_mode: 'HTML' },
});
const esc = (expr) => `{{ String(${expr}).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') }}`;
const link = (from, to, outputIndex = 0) => ({ from, to, outputIndex });
function connections(links) {
  const c = {};
  for (const l of links) {
    c[l.from] ??= { main: [] };
    while (c[l.from].main.length <= l.outputIndex) c[l.from].main.push([]);
    c[l.from].main[l.outputIndex].push({ node: l.to, type: 'main', index: 0 });
  }
  return c;
}
function workflow(key, name, nodes, links, settings = {}) {
  return { id: wid(`percapita-${key}`), name, nodes, connections: connections(links), active: false, settings: { executionOrder: 'v1', timezone: 'UTC', ...settings }, pinData: {}, tags: [] };
}
const errorWf = { errorWorkflow: wid('percapita-wf0') };

const wfs = [];

// WF0: any failed production execution -> Telegram.
wfs.push(workflow('wf0', 'WF0 Errors', [
  node('wf0', 'Error Trigger', 'n8n-nodes-base.errorTrigger', 1, [0, 0], {}),
  telegram('wf0', 'Alert on Telegram', `=⚠️ n8n: ${esc('$json.workflow.name')} failed at "${esc('$json.execution.lastNodeExecuted')}"\n${esc('$json.execution.error.message')}\n${esc('$json.execution.url')}`, [260, 0]),
], [link('Error Trigger', 'Alert on Telegram')]));

// WF1: daily topic discovery at 05:00 UTC.
wfs.push(workflow('wf1', 'WF1 Discover', [
  schedule('wf1', 'Every day 05:00 UTC', '0 5 * * *', [0, 0]),
  manual('wf1', [0, 180]),
  post('wf1', 'Find new topics', `${W}/discover`, [280, 80]),
], [link('Every day 05:00 UTC', 'Find new topics'), link('Run manually', 'Find new topics')], errorWf));

// WF2: production twice a day. Change "batch" to make several at once.
wfs.push(workflow('wf2', 'WF2 Produce', [
  schedule('wf2', 'Every day 07:00 and 15:00 UTC', '0 7,15 * * *', [0, 0]),
  manual('wf2', [0, 180]),
  node('wf2', 'Settings', 'n8n-nodes-base.set', 3.4, [240, 80], {
    mode: 'manual', assignments: { assignments: [{ id: uid('wf2:batch'), name: 'batch', value: 1, type: 'number' }] }, options: {},
  }),
  post('wf2', 'Start production', `${W}/produce`, [480, 80], '={{ JSON.stringify({ batch: $json.batch }) }}', { onError: 'continueErrorOutput' }),
  telegram('wf2', 'Worker unreachable', `=⚠️ WF2 could not reach the render worker: ${esc('$json.error?.message ?? $json.message ?? "no answer"')}\nCheck it with: docker compose ps`, [740, 180]),
], [
  link('Every day 07:00 and 15:00 UTC', 'Settings'), link('Run manually', 'Settings'),
  link('Settings', 'Start production'), link('Start production', 'Worker unreachable', 1),
], errorWf));

// WF3: after you tap Approve (and only once YOUTUBE_API_UPLOADS=on, after the API audit):
// upload privately with a scheduled publish time, add to the playlist, post the comment.
wfs.push(workflow('wf3', 'WF3 Approved upload', [
  node('wf3', 'Approved in Telegram', 'n8n-nodes-base.webhook', 2, [0, 0], { httpMethod: 'POST', path: 'percapita-approved', responseMode: 'onReceived', options: {} }, { webhookId: uid('wf3:webhook') }),
  node('wf3', 'Download video', 'n8n-nodes-base.httpRequest', 4.2, [240, 0], {
    url: '={{ $json.body.file_url }}', options: { response: { response: { responseFormat: 'file', outputPropertyName: 'data' } }, timeout: 300000 },
  }, retry),
  node('wf3', 'Upload to YouTube', 'n8n-nodes-base.youTube', 1, [480, 0], {
    resource: 'video', operation: 'upload',
    title: "={{ $('Approved in Telegram').item.json.body.title }}",
    regionCode: 'US',
    categoryId: "={{ $('Approved in Telegram').item.json.body.category_id }}",
    binaryProperty: 'data',
    options: {
      description: "={{ $('Approved in Telegram').item.json.body.description }}",
      tags: "={{ $('Approved in Telegram').item.json.body.tags.join(',') }}",
      privacyStatus: 'private',
      publishAt: "={{ $('Approved in Telegram').item.json.body.publish_at }}",
      selfDeclaredMadeForKids: false,
      defaultLanguage: 'en',
      notifySubscribers: true,
    },
  }),
  node('wf3', 'Has playlist?', 'n8n-nodes-base.if', 2.2, [720, 0], {
    conditions: { options: { caseSensitive: true, typeValidation: 'loose', version: 2 }, combinator: 'and',
      conditions: [{ id: uid('wf3:if'), leftValue: "={{ $('Approved in Telegram').item.json.body.playlist_id }}", rightValue: '', operator: { type: 'string', operation: 'notEmpty', singleValue: true } }] },
    options: {},
  }),
  node('wf3', 'Add to playlist', 'n8n-nodes-base.youTube', 1, [960, -80], {
    resource: 'playlistItem', operation: 'add',
    playlistId: "={{ $('Approved in Telegram').item.json.body.playlist_id }}",
    videoId: "={{ ($('Upload to YouTube').item.json.uploadId ?? $('Upload to YouTube').item.json.id) }}", options: {},
  }, { onError: 'continueRegularOutput' }),
  node('wf3', 'Post the comment', 'n8n-nodes-base.httpRequest', 4.2, [1200, 0], {
    method: 'POST', url: 'https://www.googleapis.com/youtube/v3/commentThreads?part=snippet',
    authentication: 'predefinedCredentialType', nodeCredentialType: 'youTubeOAuth2Api',
    sendBody: true, specifyBody: 'json',
    jsonBody: "={{ JSON.stringify({ snippet: { videoId: ($('Upload to YouTube').item.json.uploadId ?? $('Upload to YouTube').item.json.id), topLevelComment: { snippet: { textOriginal: $('Approved in Telegram').item.json.body.pinned_comment } } } }) }}",
    options: {},
  }, { onError: 'continueRegularOutput' }),
  post('wf3', 'Tell the worker', `=${W}/jobs/{{ $('Approved in Telegram').item.json.body.job_id }}/youtube`, [1440, 0], "={{ JSON.stringify({ video_id: ($('Upload to YouTube').item.json.uploadId ?? $('Upload to YouTube').item.json.id) }) }}"),
], [
  link('Approved in Telegram', 'Download video'), link('Download video', 'Upload to YouTube'), link('Upload to YouTube', 'Has playlist?'),
  link('Has playlist?', 'Add to playlist', 0), link('Has playlist?', 'Post the comment', 1), link('Add to playlist', 'Post the comment'),
  link('Post the comment', 'Tell the worker'),
], errorWf));

// WF4: Instagram cross-posts, 24 hours after each YouTube publish.
wfs.push(workflow('wf4', 'WF4 Instagram', [
  schedule('wf4', 'Every hour', '15 * * * *', [0, 0]),
  manual('wf4', [0, 180]),
  post('wf4', 'Post due Reels', `${W}/instagram/run`, [280, 80]),
], [link('Every hour', 'Post due Reels'), link('Run manually', 'Post due Reels')], errorWf));

// WF5: analytics snapshots every 6 hours, weekly report on Sunday 18:00 UTC.
wfs.push(workflow('wf5', 'WF5 Analyze', [
  schedule('wf5', 'Every 6 hours', '20 */6 * * *', [0, 0]),
  manual('wf5', [0, 180]),
  node('wf5', 'Videos due', 'n8n-nodes-base.httpRequest', 4.2, [240, 80], { url: `${W}/analytics/due`, options: {} }, { ...retry, alwaysOutputData: false }),
  node('wf5', 'Views and likes', 'n8n-nodes-base.httpRequest', 4.2, [480, 80], {
    url: "=https://www.googleapis.com/youtube/v3/videos?part=statistics&id={{ $json.video_id }}",
    authentication: 'predefinedCredentialType', nodeCredentialType: 'youTubeOAuth2Api', options: {},
  }, { ...retry, onError: 'continueRegularOutput' }),
  node('wf5', 'Retention', 'n8n-nodes-base.httpRequest', 4.2, [720, 80], {
    url: "=https://youtubeanalytics.googleapis.com/v2/reports?ids=channel==MINE&startDate={{ $('Videos due').item.json.start_date }}&endDate={{ $('Videos due').item.json.end_date }}&metrics=views,engagedViews,averageViewPercentage,averageViewDuration,likes,shares,comments,subscribersGained&filters=video=={{ $('Videos due').item.json.video_id }}",
    authentication: 'predefinedCredentialType', nodeCredentialType: 'googleOAuth2Api', options: {},
  }, { onError: 'continueRegularOutput' }),
  node('wf5', 'Retention curve', 'n8n-nodes-base.httpRequest', 4.2, [960, 80], {
    url: "=https://youtubeanalytics.googleapis.com/v2/reports?ids=channel==MINE&startDate={{ $('Videos due').item.json.start_date }}&endDate={{ $('Videos due').item.json.end_date }}&dimensions=elapsedVideoTimeRatio&metrics=audienceWatchRatio,relativeRetentionPerformance&filters=video=={{ $('Videos due').item.json.video_id }}",
    authentication: 'predefinedCredentialType', nodeCredentialType: 'googleOAuth2Api', options: {},
  }, { onError: 'continueRegularOutput' }),
  code('wf5', 'Bundle snapshot', [1200, 80],
    "return { json: { job_id: $('Videos due').item.json.job_id, win: $('Videos due').item.json.win, stats: $('Views and likes').item.json, analytics: $('Retention').item.json, curve: $input.item.json } };",
    'runOnceForEachItem'),
  post('wf5', 'Save snapshot', `${W}/analytics/snapshot`, [1440, 80], '={{ JSON.stringify($json) }}'),
  schedule('wf5', 'Sunday 18:00 UTC', '0 18 * * 0', [0, 380]),
  post('wf5', 'Weekly report', `${W}/report/weekly`, [280, 380]),
  // Channel totals for the studio's YPP wall.
  // creatorContentType is a dimension only; the API rejects it as a filter, so both reports are split
  // by type and the worker keeps the rows it needs.
  // The Save bodies are built in Code nodes: when a Google call fails, its error item breaks any
  // expression that reads it in n8n 2.x (the JSON body comes out empty). A Code node gets plain data.
  node('wf5', 'Channel', 'n8n-nodes-base.httpRequest', 4.2, [240, -140], {
    url: 'https://www.googleapis.com/youtube/v3/channels?part=statistics&mine=true',
    authentication: 'predefinedCredentialType', nodeCredentialType: 'youTubeOAuth2Api', options: {},
  }, { ...retry, onError: 'continueRegularOutput' }),
  node('wf5', 'Shorts views by day', 'n8n-nodes-base.httpRequest', 4.2, [480, -140], {
    url: "=https://youtubeanalytics.googleapis.com/v2/reports?ids=channel==MINE&startDate={{ $now.minus({ days: 90 }).toFormat('yyyy-MM-dd') }}&endDate={{ $now.toFormat('yyyy-MM-dd') }}&dimensions=day,creatorContentType&metrics=views&sort=day",
    authentication: 'predefinedCredentialType', nodeCredentialType: 'googleOAuth2Api', options: {},
  }, { onError: 'continueRegularOutput' }),
  node('wf5', 'Long-form watch time', 'n8n-nodes-base.httpRequest', 4.2, [720, -140], {
    url: "=https://youtubeanalytics.googleapis.com/v2/reports?ids=channel==MINE&startDate={{ $now.minus({ days: 365 }).toFormat('yyyy-MM-dd') }}&endDate={{ $now.toFormat('yyyy-MM-dd') }}&dimensions=creatorContentType&metrics=estimatedMinutesWatched",
    authentication: 'predefinedCredentialType', nodeCredentialType: 'googleOAuth2Api', options: {},
  }, { onError: 'continueRegularOutput' }),
  code('wf5', 'Bundle channel totals', [960, -140],
    "return [{ json: { channel: $('Channel').first().json, shorts: $('Shorts views by day').first().json, longform: $input.first().json } }];"),
  post('wf5', 'Save channel totals', `${W}/analytics/channel`, [1200, -140], '={{ JSON.stringify($json) }}'),
], [
  link('Every 6 hours', 'Channel'), link('Run manually', 'Channel'), link('Channel', 'Shorts views by day'),
  link('Shorts views by day', 'Long-form watch time'), link('Long-form watch time', 'Bundle channel totals'), link('Bundle channel totals', 'Save channel totals'),
  link('Every 6 hours', 'Videos due'), link('Run manually', 'Videos due'), link('Videos due', 'Views and likes'),
  link('Views and likes', 'Retention'), link('Retention', 'Retention curve'), link('Retention curve', 'Bundle snapshot'), link('Bundle snapshot', 'Save snapshot'), link('Sunday 18:00 UTC', 'Weekly report'),
], errorWf));

fs.mkdirSync(new URL('./workflows/', import.meta.url), { recursive: true });
for (const wf of wfs) {
  const file = new URL(`./workflows/${wf.name.split(' ')[0].toLowerCase()}.json`, import.meta.url);
  fs.writeFileSync(file, JSON.stringify(wf, null, 2) + '\n');
  console.log('wrote', file.pathname);
}
