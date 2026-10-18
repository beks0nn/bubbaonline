-- UI-level input suppression. The server's cast protocol remains authoritative.
local bot = g_modules.getModule('game_bot')
if bot and bot:isLoaded() then bot:unload() end
-- Login-only hints, event schedule and boosted-creature panels aren't used by casts.
local bottomMenu = g_modules.getModule('client_bottommenu')
if bottomMenu and bottomMenu:isLoaded() then bottomMenu:unload() end

for _, action in ipairs({'walk', 'autoWalk', 'turn', 'attack', 'follow', 'talk', 'talkChannel', 'talkPrivate',
  'use', 'useWith', 'useInventoryItem', 'useInventoryItemWith', 'move', 'rotate', 'open', 'requestTrade',
  'buyItem', 'sellItem', 'equipItem', 'mount', 'changeOutfit'}) do
  if g_game[action] then g_game[action] = function() return false end end
end

-- Bubba's cast bootstrap inserts a stack byte before creature markers in 0x6A,
-- but subsequent ordinary 7.72 updates omit it. Recognize the bootstrap form
-- without changing normal item packets (7.72 item IDs are below 0x6100).
-- Returning false makes the native parser restore the message cursor and parse
-- the packet using this feature setting. Other opcodes keep their Lua handlers.
local onOpcode = ProtocolGame.onOpcode
function ProtocolGame:onOpcode(opcode, msg)
  if opcode == 0x6A and g_game.getProtocolVersion() == 772 then
    msg:skipBytes(5) -- x, y, z
    local prefix = msg:getU16()
    local marker = math.floor(prefix / 256)
    local stackedCreature = prefix % 256 <= 9 and marker >= 0x61 and marker <= 0x63
      and msg:getUnreadSize() > 0 and msg:peekU8() == 0
    if stackedCreature then
      g_game.enableFeature(GameTileAddThingWithStackpos)
    else
      g_game.disableFeature(GameTileAddThingWithStackpos)
    end
    return false
  end
  return onOpcode(self, opcode, msg)
end

g_game.setClientVersion(772)
g_game.setProtocolVersion(g_game.getClientProtocolVersion(772))
-- Apply directly to the map: the options module may still be initializing.
local function brightenMap()
  local map = modules.game_interface.getMapPanel()
  if map then
    map:setMinimumAmbientLight(1)
    map:setDrawLights(false)
  end
end
connect(g_game, { onGameStart = function()
  brightenMap()
  g_logger.info('BUBBA_CAST_PLAYING')
end })
-- The engine polls scheduled events during initialization, before handing Lua
-- over to its game thread. Opening a socket there binds callbacks to the wrong
-- thread. Queue login from onRun: the next dispatcher poll runs on the game
-- thread (the same context as clicking Enter Game).
connect(g_app, { onRun = function()
  addEvent(function()
    local lightOk, lightError = pcall(brightenMap)
    if not lightOk then g_logger.warning(tostring(lightError)) end
    local loginOk, loginError = pcall(function()
      EnterGame.disableMotd()
      EnterGame.doLogin()
    end)
    if not loginOk then
      g_logger.info('BUBBA_CAST_LOGIN_ERROR: ' .. tostring(loginError))
    end
  end)
end })
