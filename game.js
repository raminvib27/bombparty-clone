const { nanoid } = require("nanoid")
const serialize = require("serialize-javascript")
const Timer = require("easytimer.js").Timer

const dictionary = require("./data/wordlist.json")
const { getRandomLetters } = require("./data/randomLetters")

const rooms = new Map()

function connection(io, socket) {
  const { roomId } = socket.handshake.query

  let _firstRound = true

  getRoom()
  initializeUser()
  setSettings()

  socket.join(roomId)
  socket.on("setSettings", (value) => setSettings(value))
  socket.on("checkWord", (value, userId) => checkWord(value, userId))
  socket.on("setGlobalInputText", (value) => setGlobalInputText(value))
  socket.on("startGame", () => startGame())
  socket.on("stopGame", () => stopGame())
  socket.on("getRoom", () => relayRoom())
  socket.on("updateName", (value, userId) => updateName(value, userId))
  socket.on("updateAvatar", (userId) => updateAvatar(userId))
  socket.on("message", (value) => handleMessage(value))
  socket.on("disconnect", (reason) => disconnect(reason))
  socket.on("connect_error", (err) => {
    console.log(`connect_error due to ${err.message}`)
  })

  function relayRoom() {
    const { roomId, room } = getRoom()
    io.sockets.in(roomId).emit("getRoom", serialize(room))
  }

  function setGlobalInputText(text = "") {
    io.sockets.in(roomId).emit("setGlobalInputText", text)
  }

  function updateName(value, userId) {
    if (!value) return
    const { users, messages, room } = getRoom()
    const player = users.get(userId)
    users.set(userId, { ...player, name: value })
    const updateMessages = [...messages].map((m) => ({
      ...m,
      user: { ...m.user, name: m.user.id === userId ? value : m.user.name }
    }))
    room.set("messages", new Set(updateMessages))
    relayRoom()
  }

  function updateAvatar(userId) {
    const { users } = getRoom()
    const player = users.get(userId)
    users.set(userId, { ...player, avatar: nanoid() })
    relayRoom()
  }

  function setUserLetters(userId, value) {
    const { users } = getRoom()
    const user = users.get(userId)
    const letters = new Set([...user.letters, ...value.split("")])
    if (letters.size >= 26) {
      users.set(userId, { ...user, lives: user.lives + 1, letters: new Set() })
    } else {
      users.set(userId, { ...user, letters })
    }
  }

  function checkWord(value, userId) {
    const {
      roomId,
      room,
      letterBlend,
      words,
      currentPlayer,
      timerConstructor
    } = getRoom()

    const isBlend = value.includes(letterBlend.toLowerCase())
    const isDictionary = !!dictionary[value]
    const isUnique = !words.has(value)
    const isLongEnough = value.length >= 3
    const isCurrentPlayer = currentPlayer === userId

    if (
      isBlend &&
      isDictionary &&
      isUnique &&
      isLongEnough &&
      isCurrentPlayer
    ) {
      console.log(`valid word: ${value}`)
      io.sockets
        .in(roomId)
        .emit("wordValidation", true, { value, letterBlend, currentPlayer })
      words.add(value)
      setPlayerText(userId, value)
      setUserLetters(userId, value)
      resetletterBlendCounter()
      room.set("letterBlend", getRandomLetters())
      timerConstructor.reset()
      switchPlayer()
    } else {
      console.log(`invalid word: ${value}`)
      io.sockets.in(roomId).emit("wordValidation", false, {
        isBlend,
        isDictionary,
        isUnique,
        isLongEnough,
        currentPlayer
      })
      setPlayerText(userId, "")
    }
    setGlobalInputText()
    relayRoom()
  }

  function switchPlayer() {
    const { room, users, currentPlayer } = getRoom()
    const nextPlayer = !currentPlayer
      ? getRandomPlayer(users)
      : getNextPlayer(users)
    room.set("currentPlayer", nextPlayer)
    setPlayerText(nextPlayer, "")
  }

  function loseLife() {
    const { users, currentPlayer } = getRoom()
    const player = users.get(currentPlayer)
    if (player) {
      const lives = player.lives > 0 ? player.lives - 1 : 0
      users.set(currentPlayer, { ...player, lives })
    }
  }

  function setPlayerText(userId, text) {
    const { users } = getRoom()
    const player = users.get(userId)
    users.set(userId, { ...player, text })
  }

  function getRandomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min
  }

  function resetTimer() {
    const { room, timerConstructor, hardMode, settings } = getRoom()
    const settingsTimer = settings.get("timer")
    if (hardMode && settingsTimer > 1) {
      const num = getRandomInt(0, Math.ceil(settingsTimer / 2))
      const seconds = settingsTimer - num
      timerConstructor.stop()
      timerConstructor.start({ startValues: { seconds } })
      room.set("timer", seconds)
    } else {
      room.set("timer", settingsTimer)
    }
  }

  function updateTimer() {
    const { room, timerConstructor } = getRoom()
    const { seconds } = timerConstructor.getTimeValues()
    room.set("timer", seconds)
    relayRoom()
  }

  function updateSecondsTimer() {
    const { timerConstructor } = getRoom()
    io.sockets.in(roomId).emit("boom", true)
    loseLife()
    const hasWinner = checkGameState()
    if (!hasWinner) {
      switchPlayer()
      decrementletterBlendCounter()
      timerConstructor.reset()
    }
    relayRoom()
  }

  function resetletterBlendCounter() {
    const { room, settings } = getRoom()
    const settingsLetterBlendCounter = settings.get("letterBlendCounter")
    room.set("letterBlendCounter", settingsLetterBlendCounter)
  }

  function decrementletterBlendCounter() {
    const { room, letterBlendCounter, settings } = getRoom()
    const counter = letterBlendCounter - 1
    room.set("letterBlendCounter", counter)
    if (counter <= 0) {
      const settingsLetterBlendCounter = settings.get("letterBlendCounter")
      room.set("letterBlend", getRandomLetters())
      room.set("letterBlendCounter", settingsLetterBlendCounter)
    }
  }

  function startGame() {
    const { room, settings, timerConstructor } = getRoom()
    const startTimer = settings.get("timer")
    room
      .set("timer", startTimer)
      .set("running", true)
      .set("letterBlend", getRandomLetters())
      .set("words", new Set())
      .set("round", 1)
      .set("hardMode", false)
      .set("startingPlayer", "")

    _firstRound = true
    resetletterBlendCounter()
    resetUser()
    switchPlayer()

    timerConstructor.on("started", updateTimer)
    timerConstructor.on("reset", resetTimer)
    timerConstructor.on("secondsUpdated", updateTimer)
    timerConstructor.on("targetAchieved", updateSecondsTimer)

    timerConstructor.start({ startValues: { seconds: startTimer } })
  }

  function checkGameState() {
    const { users } = getRoom()
    const remainingPlayers = Array.from(users).filter(
      ([, value]) => value.lives > 0
    )
    const hasWinner = remainingPlayers.length <= 1
    if (hasWinner) {
      io.sockets.in(roomId).emit("winner", true)
      const [, winner] = remainingPlayers?.[0] || [...users][0]
      stopGame(winner)
    }
    return hasWinner
  }

  function stopGame(player) {
    const { room, timerConstructor } = getRoom()
    timerConstructor.stop()
    timerConstructor.removeAllEventListeners()
    room
      .set("winner", player)
      .set("running", false)
      .set("currentPlayer", "")
      .set("letterBlend", "")
    relayRoom()
  }

  function resetUser() {
    const { room, users, settings } = getRoom()
    const lives = settings.get("lives")
    const updatedUsers = Array.from(users, ([key, value]) => {
      return [key, { ...value, letters: new Set(), lives, text: "" }]
    })
    room.set("users", new Map(updatedUsers))
  }

  function incrementRound() {
    const { room, round, settings } = getRoom()
    const hardMode = settings.get("hardMode")
    const newRound = round + 1
    if (newRound > hardMode) {
      room.set("hardMode", true)
    }
    room.set("round", newRound)
  }

  function getNextPlayer(collection) {
    const { currentPlayer, startingPlayer } = getRoom()

    if (currentPlayer === startingPlayer) {
      if (_firstRound) {
        _firstRound = false
      } else {
        incrementRound()
      }
    }

    const players = [...collection]
    let currentIndex = players.findIndex(([key]) => key === currentPlayer)

    if (currentIndex === players.length - 1) currentIndex = 0

    let nextPlayerId
    for (let i = currentIndex; i < players.length; i++) {
      const [id, val] = players[i]
      if (val.lives <= 0 || id === currentPlayer) continue
      nextPlayerId = id
      break
    }

    if (!nextPlayerId) {
      const remainingPlayers = players.filter(([, val]) => val.lives > 0)
      nextPlayerId = remainingPlayers[0][0]
    }

    return nextPlayerId
  }

  function getRandomPlayer(collection) {
    const { room } = getRoom()
    const keys = Array.from(collection.keys())
    const randomPlayer = keys[Math.floor(Math.random() * keys.length)]
    room.set("startingPlayer", randomPlayer)
    return randomPlayer
  }

  function getRoom() {
    const { roomId } = socket.handshake.query
    const room = rooms.get(roomId) || rooms.set(roomId, new Map())
    const setProp = (prop, initialValue) =>
      room.get(prop) || room.set(prop, initialValue).get(prop)

    const props = {
      messages: setProp("messages", new Set()),
      users: setProp("users", new Map()),
      words: setProp("words", new Set()),
      letterBlend: setProp("letterBlend", ""),
      timerConstructor: setProp(
        "timerConstructor",
        new Timer({ countdown: true })
      ),
      timer: setProp("timer", 0),
      round: setProp("round", 0),
      hardMode: setProp("hardMode", false),
      currentPlayer: setProp("currentPlayer", ""),
      startingPlayer: setProp("startingPlayer", ""),
      running: setProp("running", false),
      winner: setProp("winner", null),
      letterBlendCounter: setProp("letterBlendCounter", 0),
      settings: setProp("settings", new Map())
    }

    return { room, roomId, ...props }
  }

  function initializeUser() {
    const { name, userId } = socket.handshake.auth
    const { users } = getRoom()
    users.set(userId, {
      id: userId,
      name,
      letters: new Set(),
      avatar: nanoid()
    })
    io.sockets.in(roomId).emit("userJoined", userId)
    stopGame()
  }

  function setSettings(data) {
    const { settings } = getRoom()

    const timer = data?.timer || settings.get("timer") || 10
    const lives = data?.lives || settings.get("lives") || 2
    const hardMode = data?.hardMode || settings.get("hardMode") || 5
    const letterBlendCounter =
      data?.letterBlendCounter || settings.get("letterBlendCounter") || 2
    settings
      .set("timer", Number(timer))
      .set("lives", lives)
      .set("hardMode", hardMode)
      .set("letterBlendCounter", letterBlendCounter)
    if (data) {
      io.sockets.in(roomId).emit("setSettings", serialize(settings))
      relayRoom()
    }
  }

  function handleMessage(value) {
    const { userId } = socket.handshake.auth

    const { messages, users } = getRoom()
    const message = {
      id: nanoid(),
      user: users.get(userId),
      value,
      time: Date.now()
    }

    messages.add(message)
    relayRoom()
  }

  function disconnect(reason) {
    const { userId } = socket.handshake.auth
    const { users } = getRoom()
    console.log({ reason })
    users.delete(userId)
    stopGame()
    // socket.leave(roomId)
    // socket.disconnect(true)
    relayRoom()
  }
}

function chat(io) {
  // io.use(userHandler)
  io.on("connection", (socket) => {
    connection(io, socket)
  })
}

module.exports = chat