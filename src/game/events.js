/**
 * In-process pub/sub for live game state push (SSE subscribers).
 */

const { EventEmitter } = require("events");

const bus = new EventEmitter();
bus.setMaxListeners(200);

function publishGameEvent(gameId, payload) {
  const event = {
    ...payload,
    gameId,
    at: new Date().toISOString()
  };
  bus.emit(`game:${gameId}`, event);
  bus.emit("game:*", event);
}

function subscribeGameEvents(gameId, listener) {
  const channel = `game:${gameId}`;
  bus.on(channel, listener);
  return () => bus.off(channel, listener);
}

module.exports = {
  publishGameEvent,
  subscribeGameEvents
};
