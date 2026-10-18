import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function createOverlays(bundle, config) {
const js = readFileSync(resolve(bundle, 'otclient.js'), 'utf8');
const data = readFileSync(resolve(bundle, 'otclient.data'));
function packagedFile(name) {
  const entry = [...js.matchAll(/\{filename:"([^"]+)",start:(\d+),end:(\d+)\}/g)].find(match => match[1] === name);
  if (!entry) throw new Error(`Release does not contain ${name}`);
  return data.subarray(Number(entry[2]), Number(entry[3])).toString('utf8');
}
function replaceOnce(source, find, replacement) {
  if (source.split(find).length !== 2) throw new Error(`Unexpected release layout: ${find}`);
  return source.replace(find, replacement);
}
// Configure the bundled engine before it discovers modules, using its normal paths.
const settings = `
Services = { clientAssets = { enabled = false, strictManifestSha256 = true, allowRawFallbackHashMismatch = false } }
Servers_init = { [${JSON.stringify(config.targetHost)}] = { port = ${config.loginPort}, protocol = 772, httpLogin = false } }
g_settings.set('host', ${JSON.stringify(config.targetHost)})
g_settings.set('port', ${config.loginPort})
g_settings.set('client-version', 772)
g_settings.set('httpLogin', false)
g_settings.set('autologin', false)
g_settings.set('account', '')
g_settings.set('password', '')
g_settings.set('locale', 'en')
g_settings.set('ambientLight', 100)
g_settings.set('enableLights', false)
g_settings.set('musicSoundVolume', 50)
if g_resources.fileExists('/cast-online.lua') then dofile('/cast-online.lua') end
`;
const init = replaceOnce(packagedFile('/init.lua'), "g_modules.ensureModuleLoaded('corelib')", `g_modules.ensureModuleLoaded('corelib')\n${settings}`);
let enter = packagedFile('/modules/client_entergame/entergame.lua');
enter = replaceOnce(enter, 'local motdEnabled = true', 'local motdEnabled = false');
enter = replaceOnce(enter, '    CharacterList.create(characters, account, otui)', "    g_logger.info('BUBBA_CAST_LIST_READY')\n    CharacterList.create(characters, account, otui)");
enter = replaceOnce(enter, 'local function onError(protocol, message, errorCode)', "local function onError(protocol, message, errorCode)\n    g_logger.info('BUBBA_CAST_LOGIN_ERROR: ' .. tostring(message))");
enter = replaceOnce(enter, "enterGame = g_ui.displayUI('entergame')", `enterGame = g_ui.displayUI('entergame')
    enterGame:setText('Watch a cast')
    enterGame:getChildById('accountNameTextEdit'):setEnabled(false)
    enterGame:getChildById('accountPasswordTextEdit'):setEnabled(false)`);
for (const [field, widget] of [['account', 'accountNameTextEdit'], ['password', 'accountPasswordTextEdit']]) {
  const find = `G.${field} = enterGame:getChildById('${widget}'):getText()`;
  if (enter.split(find).length !== 3) throw new Error('Unexpected release login paths');
  enter = enter.replaceAll(find, `G.${field} = '' -- cast login only`);
}
let login = packagedFile('/modules/gamelib/protocollogin.lua');
login = replaceOnce(login, 'msg:addU32(tonumber(self.accountName))', 'msg:addU32(tonumber(self.accountName) or 0)');
// Legacy 7.72 items use OTCv8's 500 ms frames (fire, water, etc.).
// The browser release sets these to 75 ms, the timing used for spell effects.
const setup = replaceOnce(packagedFile('/data/setup.otml'), 'item-ticks-per-frame: 75', 'item-ticks-per-frame: 500');
let topMenu = packagedFile('/modules/client_topmenu/topmenu.lua');
topMenu = replaceOnce(topMenu, '    return button', `    if id == 'logoutButton' or id == 'terminalButton' or id == 'otuiEditorButton' then
        button:hide()
    end
    return button`);
topMenu = replaceOnce(topMenu, "    topLeftOnlinePlayersLabel = topMenu:recursiveGetChildById('topLeftOnlinePlayersLabel')", `    topLeftOnlinePlayersLabel = topMenu:recursiveGetChildById('topLeftOnlinePlayersLabel')
    local count = g_settings.getNumber('castPlayersOnline', -1)
    setPlayersOnline(count >= 0 and tostring(count) or '?')`);
topMenu = replaceOnce(topMenu, "    topLeftDiscordLink = topMenu:recursiveGetChildById('discordIcon')", `    topLeftDiscordLink = topMenu:recursiveGetChildById('discordIcon')
    topMenu.topLeftDiscord:hide()
    topMenu.topLeftDiscord:setWidth(0)
    topMenu.topLeftYoutube:hide()
    topMenu.topLeftYoutube:setWidth(0)
    local youtube = addLeftButton('castYoutube', 'YouTube', nil, function()
      g_logger.info('BUBBA_CAST_LINK:youtube')
    end)
    youtube:setTooltip('BubbaYoutube')
    local discord = addLeftButton('castDiscord', 'Discord', nil, function()
      g_logger.info('BUBBA_CAST_LINK:discord')
    end)
    discord:setTooltip('BubbaDiscord')
    local twitch = addLeftButton('castTwitch', 'Twitch', nil, function()
      g_logger.info('BUBBA_CAST_LINK:twitch')
    end)
    twitch:setTooltip('BubbaTwitch')`);
for (const [find, replacement] of [
  ['topMenu.topLeftDiscord:show()', 'topMenu.topLeftDiscord:hide()'],
  ['topMenu.topLeftYoutube:show()', 'topMenu.topLeftYoutube:hide()'],
  ['topMenu.topLeftDiscord:setWidth(110)', 'topMenu.topLeftDiscord:setWidth(0)'],
  ['topMenu.topLeftYoutube:setWidth(100)', 'topMenu.topLeftYoutube:setWidth(0)'],
]) topMenu = replaceOnce(topMenu, find, replacement);
// The browser build's g_platform.openUrl is a no-op. Forward only these named
// links to the page, which maps them to a fixed allowlist of destinations.
topMenu = replaceOnce(topMenu, 'g_platform.openUrl(url_youtube)', "g_logger.info('BUBBA_CAST_LINK:youtube')");
topMenu = replaceOnce(topMenu, 'g_platform.openUrl(url_discord)', "g_logger.info('BUBBA_CAST_LINK:discord')");
let background = packagedFile('/modules/client_background/background.lua');
background = replaceOnce(background, "    clientVersionLabel = background:getChildById('clientVersionLabel')", "    clientVersionLabel = background:getChildById('clientVersionLabel')\n    clientVersionLabel:hide()");
background = replaceOnce(background, 'g_effects.fadeIn(clientVersionLabel, 1500)', 'clientVersionLabel:hide()');
return {
  '/overlay/background.lua': background,
  '/overlay/topmenu.lua': topMenu,
  '/overlay/setup.otml': setup,
  '/overlay/init.lua': init,
  '/overlay/entergame.lua': enter,
  '/overlay/protocollogin.lua': login,
};
}
