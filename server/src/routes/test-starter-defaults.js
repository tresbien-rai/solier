/**
 * Starter defaults test (DF-01).
 *
 * Verifies that seeding a brand-new user creates Soli (Companion, starter
 * traits that all resolve in `js/persona-traits.js`, shared model mode with no
 * hardcoded Sonnet 4) and leaves `currentModelConfig` explicitly unset
 * (`provider: null, model: null`).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Load a zero-import frontend ES module in Node 20+ without requiring
 * `"type": "module"` in package.json (same pattern as providers/test-modelparams.js).
 */
async function importFrontendEsm(relFromRepoRoot) {
  const src = fs.readFileSync(path.resolve(__dirname, '../../..', relFromRepoRoot), 'utf8');
  return import(`data:text/javascript;charset=utf-8,${encodeURIComponent(src)}`);
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solier-df01-'));
process.env.DB_PATH = path.join(tmpDir, 'test.db');

const { closeDb } = require('../db/connection');
const dal = require('../db/dal');
const authRouter = require('./auth');

let failures = 0;
function check(label, cond, detail = '') {
  if (cond) {
    console.log(`   ✓ ${label}`);
  } else {
    failures++;
    console.error(`   ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

async function main() {
  console.log('============================================================');
  console.log('Starter Defaults Test (DF-01)');
  console.log('============================================================\n');

  const user = dal.createUser({
    googleId: 'g-starter-test',
    email: 'starter@example.com',
    displayName: 'Starter Tester',
  });

  authRouter.seedNewUserDefaults(user.id);

  const personas = dal.getPersonasByUser(user.id);
  check('seeds exactly one starter persona', personas.length === 1, `got ${personas.length}`);

  const soli = personas[0] || {};
  check('starter persona is named Soli', soli.name === 'Soli', `got ${soli.name}`);
  check('role_label is Companion', soli.role_label === 'Companion', `got ${soli.role_label}`);
  check('tagline is set', soli.tagline === 'Always a spare chair by the window.', `got ${soli.tagline}`);
  check('modelConfig uses shared mode with no hardcoded model',
    soli.modelConfig?.mode === 'shared' && !soli.modelConfig?.model && !soli.modelConfig?.provider,
    JSON.stringify(soli.modelConfig));
  check('General guidance is concise and non-boilerplate',
    typeof soli.system_prompt === 'string' && soli.system_prompt.length > 0 && !soli.system_prompt.includes('helpful AI assistant'),
    soli.system_prompt);

  // Verify every seeded trait ID actually resolves in the real frontend trait library
  const { findTrait } = await importFrontendEsm('js/persona-traits.js');
  const seededTraits = soli.traits || {};
  let traitCount = 0;
  let allKnown = true;
  for (const [sectionId, picks] of Object.entries(seededTraits)) {
    for (const pick of picks) {
      traitCount++;
      if (!findTrait(sectionId, pick.id)) {
        allKnown = false;
        console.error(`     unknown trait: ${sectionId}/${pick.id}`);
      }
    }
  }
  check('seeds 6 starter traits across 4 sections, all valid in persona-traits.js',
    traitCount === 6 && allKnown, `count=${traitCount}, allKnown=${allKnown}`);

  const settings = dal.getSettingsByUser(user.id);
  check('currentModelConfig is seeded as explicitly unset (provider: null, model: null)',
    settings?.currentModelConfig?.provider === null && settings?.currentModelConfig?.model === null,
    JSON.stringify(settings?.currentModelConfig));

  // Verify frontend CONFIG.defaults also has no hardcoded Sonnet 4 and keeps streaming on
  const { CONFIG, getDefaultModelConfig } = await importFrontendEsm('js/config.js');
  const defCfg = getDefaultModelConfig();
  check('frontend CONFIG.defaults has provider: null, model: null, streaming: true, maxTokens: 8192',
    CONFIG.defaults.provider === null
      && CONFIG.defaults.model === null
      && defCfg.provider === null
      && defCfg.model === null
      && defCfg.modelParams.streaming === true
      && defCfg.modelParams.maxTokens === 8192,
    JSON.stringify({ provider: defCfg.provider, model: defCfg.model, streaming: defCfg.modelParams.streaming, maxTokens: defCfg.modelParams.maxTokens }));

  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });

  console.log('\n============================================================');
  if (failures > 0) {
    console.error(`${failures} check(s) failed`);
    process.exit(1);
  }
  console.log('All starter defaults tests passed!');
  console.log('============================================================');
}

main().catch((err) => {
  console.error(err);
  try { closeDb(); } catch {}
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(1);
});
