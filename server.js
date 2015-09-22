// Dependencies
var express = require('express')
, app = express()
, bodyParser = require('body-parser')
, expressValidator = require('express-validator')
, methodOverride = require('method-override')
, npid = require('npid')
, uuid = require('node-uuid')
, Room = require('./room.js')
, _ = require('underscore')._
, amqp = require('amqplib')
, amqp_host = 'amqp://localhost'
, broker_exchange = 'com.paytm';


app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(expressValidator());

app.set('port', process.env.PORT || 2428);

var server = app.listen(app.get('port'), function (err) {
	if (err) {
		console.log("Error starting server");
		return;
	}
	console.log("Web server started");
});


var io = require('socket.io').listen(server);


app.use(express.static(__dirname + '/public'));
app.use('/js', express.static(__dirname + '/public/js'));
app.use('/components', express.static(__dirname + '/public/components'));
app.set('views', __dirname + '/public/views');
app.engine('html', require('ejs').renderFile);


// Elevated privileges required
/*try {
    npid.create('/var/run/advanced-chat.pid', true);
} catch (err) {
    console.log(err);
    //process.exit(1);
}*/


app.get('/', function (req, res) {
	res.render(__dirname + '/public/views/index.html');
});


var people = {};
var rooms = {};
var sockets = [];
var chatHistory = {};


function purge(s, action) {
	if (people[s.id].inroom) {								// User is in a room
		var room = rooms[people[s.id].inroom];				// Check which room user is in

		if (s.id === room.owner) {							// User is the owner of the room
			if (action === "disconnect") {

				io.sockets.in(s.room).emit("update", "The owner (" + people[s.id].name + ") has left the server. The room is removed and you have been disconnected from it.");
				var socketids = [];
				for (var i=0; i<sockets.length; i++) {
					socketids.push(sockets[i].id);
					if (_.contains((socketids)), room.people) {
						sockets[i].leave(room.name);
					}
				}

				if (_.contains((room.people)), s.id) {
					for (var i=0; i<room.people.length; i++) {
						people[room.people[i]].inroom = null;
					}
				}

				room.people = _.without(room.people, s.id);
				delete rooms[people[s.id].owns];
				delete people[s.id];
				delete chatHistory[room.name];
				sizePeople = _.size(people);
				sizeRooms = _.size(rooms);
				io.sockets.emit("update-people", { people : people, count : sizePeople });
				io.sockets.emit("roomList", { rooms : rooms, count : sizeRooms });
				var o = _.findWhere(sockets, { 'id' : s.id });
				sockets = _.without(sockets, o);

			} else if (action === "removeRoom") {

				io.sockets.in(s.room).emit("update", "The owner (" +people[s.id].name + ") has removed the room. The room is removed and you have been disconnected from it as well.");
				var socketids = [];
				for (var i=0; i<sockets.length; i++) {
					socketids.push(sockets[i].id);
					if(_.contains((socketids)), room.people) {
						sockets[i].leave(room.name);
					}
				}

				if(_.contains((room.people)), s.id) {
					for (var i=0; i<room.people.length; i++) {
						people[room.people[i]].inroom = null;
					}
				}
				delete rooms[people[s.id].owns];
				people[s.id].owns = null;
				room.people = _.without(room.people, s.id);
				delete chatHistory[room.name];
				sizeRooms = _.size(rooms);
				io.sockets.emit("roomList", {rooms: rooms, count: sizeRooms});

			} else if (action === "leaveRoom") {

				io.sockets.in(s.room).emit("update", "The owner (" +people[s.id].name + ") has left the room. The room is removed and you have been disconnected from it as well.");
				var socketids = [];
				for (var i=0; i<sockets.length; i++) {
					socketids.push(sockets[i].id);
					if(_.contains((socketids)), room.people) {
						sockets[i].leave(room.name);
					}
				}

				if(_.contains((room.people)), s.id) {
					for (var i=0; i<room.people.length; i++) {
						people[room.people[i]].inroom = null;
					}
				}
				delete rooms[people[s.id].owns];
				people[s.id].owns = null;
				room.people = _.without(room.people, s.id);
				delete chatHistory[room.name];
				sizeRooms = _.size(rooms);
				io.sockets.emit("roomList", {rooms: rooms, count: sizeRooms});

			}

		} else {		// User in room but does not own room

			if (action === "disconnect") {

				io.sockets.emit("update", people[s.id].name + " has disconnected from the server.");
				if (_.contains((room.people), s.id)) {
					var personIndex = room.people.indexOf(s.id);
					room.people.splice(personIndex, 1);
					s.leave(room.name);
				}
				delete people[s.id];
				sizePeople = _.size(people);
				io.sockets.emit("update-people", {people: people, count: sizePeople});
				var o = _.findWhere(sockets, {'id': s.id});
				sockets = _.without(sockets, o);

			} else if (action === "removeRoom") {

				s.emit("update", "Only the owner can remove a room.");

			} else if (action === "leaveRoom") {

				if (_.contains((room.people), s.id)) {
					var personIndex = room.people.indexOf(s.id);
					room.people.splice(personIndex, 1);
					people[s.id].inroom = null;
					io.sockets.emit("update", people[s.id].name + " has left the room.");
					s.leave(room.name);
				}

			}
		}

	} else {
		//The user isn't in a room, but maybe he just disconnected
		if (action === "disconnect") {
			io.sockets.emit("update", people[s.id].name + " has disconnected from the server.");
			delete people[s.id];
			sizePeople = _.size(people);
			io.sockets.emit("update-people", {people: people, count: sizePeople});
			var o = _.findWhere(sockets, {'id': s.id});
			sockets = _.without(sockets, o);
		}
	}
}


function send_to_broker (messageAddress, message) {

	var connection, channel;

	function reportError(err){
	  console.log("Error!");
	  console.log(err.stack);
	  process.exit(1);
	}

	function createChannel(conn){
	  connection = conn;
	  return connection.createChannel();
	}

	function createExchange(ch){
	  channel = ch;
	  return channel.assertExchange(broker_exchange, "direct");
	}

	function sendMessage(){
	  var msg = new Buffer(message);
	  console.log("Sending message : "+message+" to : "+messageAddress);
	  channel.publish(broker_exchange, messageAddress, msg);
	  return channel.close();
	}

	amqp.connect(amqp_host)
	  .then(createChannel)
	  .then(createExchange)
	  .then(sendMessage)
	  .then(process.exit, reportError);

}


function receive_from_broker (messageAddress, io, socket) {

	var queueName = "com.paytm.q";
	var connection, channel;

	function reportError(err){
	  console.log("Error!");
	  console.log(err.stack);
	  process.exit(1);
	}

	function createChannel(conn){
	  connection = conn;
	  return connection.createChannel();
	}

	function createExchange(ch){
	  channel = ch;
	  return channel.assertExchange(broker_exchange, "direct");
	}

	function createQueue(){
	  return channel.assertQueue(queueName);
	}

	function bindExQueue(){
	  return channel.bindQueue(queueName, broker_exchange, messageAddress);
	}

	function consumeMessages(){
	  channel.consume(queueName, function(msg){
	    if (!msg) { return; }

	    console.log("Received a message!");
	    console.log(messageAddress);
	    console.log(msg.content.toString());
	    return (msg.content.toString());
	    //socket.emit("whisper", "", { name : "You" }, msg.content.toString());
		//io.sockets.connected[messageAddress].emit("whisper", "", people[socket.id], msg.content.toString());
	    channel.ack(msg);
	  });
	}

	amqp.connect(amqp_host)
	  .then(createChannel)
	  .then(createExchange)
	  .then(createQueue)
	  .then(bindExQueue)
	  .then(consumeMessages)
	  .then(undefined, reportError);

}


io.sockets.on("connection", function (socket) {

	receive_from_broker(socket.id, io, socket);

	socket.on("joinserver", function (name, device) {

		var exists = false;
		var ownerRoomID = inRoomID = null;

		_.find(people, function (key, value) {
			if (key.name.toLowerCase === name.toLowerCase())
				return exists = true;
		});

		if (exists) {	// Unique username
			var randomNumber = Math.floor(Math.random()*1001);
			do {
				proposedName = name + randomNumber;
				_.find(people, function (key, value) {
					if (key.name.toLowerCase === proposedName.toLowerCase())
						return exists = true;
				})
			} while (!exists);
			socket.emit("exists", {msg: "Username already exists", proposedName : proposedName});
		} else {
			people[socket.id] = {"name" : name, "owns" : ownerRoomID, "inroom" : inRoomID, "device" : device};
			socket.emit("update", "You have connected to the server");
			io.sockets.emit("update", people[socket.id].name + " is online")
			sizePeople = _.size(people);
			sizeRooms = _.size(rooms);
			io.sockets.emit("update-people", { people : people, count : sizePeople });
			socket.emit("roomList", { rooms : rooms, count : sizeRooms });
			socket.emit("joined");
			sockets.push(socket);
		}
	});


	socket.on("getOnlinePeople", function (fn) {
		fn({ people : people });
	});


	socket.on("joinUpdate", function () {
		io.sockets.emit("update-people", { people : people, count : sizePeople });
	});


	socket.on("typing", function (data) {
		if (typeof people[socket.id] !== "undefined")
			io.sockets.in(socket.room).emit("isTyping", { isTyping : data, person : people[socket.id].name });
	});


	socket.on("send", function (msTime, msg) {

		var re = /^[w]:.*:/;
		var whisper = re.test(msg);
		var whisperStr = msg.split(":");
		var found = false;

		if (whisper) {
			var whisperTo = whisperStr[1];
			var keys = Object.keys(people);

			if (keys.length != 0) {
				for (var i=0; i < keys.length; i++) {
					if (people[keys[i]].name === whisperTo) {
						var whisperId = keys[i];
						found = true;
						if (socket.id === whisperId) {
							socket.emit("update", "You can't whisper to yourself");
						}
						break;
					}
				}
			}

			if (found && socket.id !== whisperId) {
				var whisperTo = whisperStr[1];
				var whisperMsg = whisperStr[2];

				// Send message to broker
				send_to_broker(whisperId, whisperMsg);

				// socket.emit("whisper", msTime, { name : "You" }, whisperMsg);
				// io.sockets.connected[whisperId].emit("whisper", msTime, people[socket.id], whisperMsg);
			} else {
				socket.emit("update", "Can't find " + whisperTo);
			}
		} else {
			var clients_in_the_room = io.sockets.adapter.rooms[socket.room];
			if (socket.id !== undefined && clients_in_the_room[socket.id]) {
				io.sockets.in(socket.room).emit("chat", msTime, people[socket.id], msg);
				socket.emit("isTyping", false);
				if (_.size(chatHistory[socket.room]) > 10) {
					chatHistory[socket.room].splice(0,1);
				} else {
					chatHistory[socket.room].push(people[socket.id].name + ":" + msg);
				}
			} else {
				socket.emit("update", "Please connect to a room");
			}
		}
	});


	socket.on("disconnect", function() {
		if (typeof people[socket.id] !== "undefined") {
			purge(socket, "disconnect");
		}
	});


	socket.on("createRoom", function (name) {
		if (people[socket.id].inroom) {
			socket.emit("update", "You are in a room. Please leave it first to create a new one.");
		} else if (!people[socket.id].owns) {
			var id = uuid.v4();
			var room = new Room(name, id, socket.id);
			rooms[id] = room;
			sizeRooms = _.size(rooms);
			io.sockets.emit("roomList", { rooms : rooms, count : sizeRooms });
			socket.room = name;
			socket.join(socket.room);
			people[socket.id].owns = id;
			people[socket.id].inroom = id;
			room.addPerson(socket.id);
			socket.emit("update", "Welcome to " + room.name + ".");
			socket.emit("sendRoomID", { id : id });
			chatHistory[socket.room] = [];
		} else {
			socket.emit("You have already created a room.");
		}
	});


	socket.on("check", function (name, fn) {
		var match = false;
		_.find(rooms, function (key, value) {
			if (key.name === name) {
				return match = true;
			}
		});
		fn ({ result : match });
	});


	socket.on("removeRoom", function (id) {
		var room = rooms[id];
		if (socket.id === room.owner) {
			purge(socket, "removeRoom");
		} else {
			socket.emit("update", "Only the owner can remove a room");
		}
	});


	socket.on("joinRoom", function (id) {
		if (typeof people[socket.id] !== "undefined") {
			var room = rooms[id];
			if (socket.id === room.owner) {
				socket.emit("update", "You are the owner of this rooms and you have already joined");
			} else {
				if (_.contains((room.people), socket.id)) {
					socket.emit("update", "You have already joined the room");
				} else {
					if (people[socket.id].inroom !== null) {
						socket.emit("update", "You are already in a room (" + rooms[people[socket.id].inroom].name + "), please leave it first to join another room");
					} else {
						room.addPerson(socket.id);
						people[socket.id].inroom = id;
						socket.room = room.name;
						socket.join(socket.room);
						user = people[socket.id];
						io.sockets.in(socket.room).emit("update", user.name + " has connected to " + room.name + " room");
						socket.emit("update", "Welcome to " + room.name + ".");
						socket.emit("sendRoomID", { id : id });
						var keys = _.keys(chatHistory);
						if (_.contains(keys, socket.room)) {
							socket.emit("history", chatHistory[socket.room]);
						}
					}
				}
			}
		} else {
			socket.emit("update", "Please enter a valid name first");
		}
	});


	socket.on("leaveRoom", function (id) {
		var room = rooms[id];
		if (room) {
			purge(socket, "leaveRoom");
		}
	});


});
