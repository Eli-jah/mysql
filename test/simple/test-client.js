require('../common');
var StreamStub = GENTLY.stub('net', 'Stream')
  , ParserStub = GENTLY.stub('./parser')
  , OutgoingPacketStub = GENTLY.stub('./outgoing_packet')
  , Parser = require('mysql/parser')
  , Client = require('mysql/client');

for (var k in Parser) {
  ParserStub[k] = Parser[k];
}

function test(test) {
  client = new Client();
  gently = new Gently();
  test();
  gently.verify(test.name);
}

test(function constructor() {
  (function testDefaultProperties() {
      var client = new Client();

      assert.strictEqual(client.host, 'localhost');
      assert.strictEqual(client.port, 3306);
      assert.strictEqual(client.user, null);
      assert.strictEqual(client.password, null);
      assert.strictEqual(client.database, null);

      assert.strictEqual(client.flags, Client.defaultFlags);
      assert.strictEqual(client.maxPacketSize, 0x01000000);
      assert.strictEqual(client.charsetNumber, 8);

      assert.deepEqual(client._queue, []);
      assert.strictEqual(client._connection, null);
      assert.strictEqual(client._parser, null);
  })();

  (function testMixin() {
    var client = new Client({foo: 'bar'});
    assert.strictEqual(client.foo, 'bar');
  })();

  (function testWithoutNew() {
    var client = Client({foo: 'bar'});
    assert.strictEqual(client.foo, 'bar');
  })();
});

test(function connect() {
  var CONNECTION
    , PARSER
    , onConnection = {}
    , onParser = {}
    , CB = function() {};

  gently.expect(client, '_enqueue', function(task, cb) {
    assert.strictEqual(cb, CB);
    task();
  });

  gently.expect(StreamStub, 'new', function() {
    CONNECTION = this;

    gently.expect(CONNECTION, 'connect', function(port, host) {
      assert.equal(port, client.port);
      assert.equal(host, client.host);
    });

    var events = ['error', 'data'];
    gently.expect(CONNECTION, 'on', events.length, function(event, fn) {
      assert.equal(event, events.shift());
      onConnection[event] = fn;
      return this;
    });
  });

  gently.expect(ParserStub, 'new', function() {
    PARSER = this;

    var events = ['packet'];
    gently.expect(PARSER, 'on', events.length, function(event, fn) {
      assert.equal(event, events.shift());
      onParser[event] = fn;
      return this;
    });
  });

  client.connect(CB);

  assert.strictEqual(client._connection, CONNECTION);
  assert.strictEqual(client._parser, PARSER);

  (function testConnectionError() {
    var ERR = new Error('ouch');
    gently.expect(client, 'emit', function(event, err) {
      assert.equal(event, 'error');
      assert.equal(err, ERR);
    });

    onConnection.error(ERR);
  })();

  (function testOnConnectionData() {
    var BUFFER = {};
    gently.expect(PARSER, 'write', function(buffer) {
      assert.strictEqual(buffer, BUFFER );
    });

    onConnection.data(BUFFER );
  })();

  (function testOnParserGreetingPacket() {
    var PACKET = {type: Parser.GREETING_PACKET};

    gently.expect(client, '_greetingPacket', function(packet) {
      assert.strictEqual(packet, PACKET);
    });

    onParser.packet(PACKET);
  })();

  (function testOnParserErrorPacket() {
    var PACKET = {type: Parser.ERROR_PACKET};

    gently.expect(client, '_errorPacket', function(packet) {
      assert.strictEqual(packet, PACKET);
    });

    onParser.packet(PACKET);
  })();

  (function testOnParserOkPacket() {
    var PACKET = {type: Parser.OK_PACKET};

    gently.expect(client, '_okPacket', function(packet) {
      assert.strictEqual(packet, PACKET);
    });

    onParser.packet(PACKET);

  })();
});

test(function _greetingPacket() {
  var GREETING = {scrambleBuffer: new Buffer(20), number: 1}
    , TOKEN = new Buffer(8)
    , PACKET;

  client.user = 'root';
  client.password = 'hello world';
  client.database = 'secrets';

  gently.expect(HIJACKED['./auth'], 'token', function(password, scramble) {
    assert.strictEqual(password, client.password);
    assert.strictEqual(scramble, GREETING.scrambleBuffer);
    return TOKEN;
  });

  gently.expect(OutgoingPacketStub, 'new', function(size, number) {
    assert.equal
      ( size
      ,   4 + 4 + 1 + 23
        + client.user.length + 1
        + TOKEN.length + 1
        + client.database.length + 1
      );
    assert.equal(number, GREETING.number + 1);
    PACKET = this;

    gently.expect(PACKET, 'writeNumber', function(bytes, number) {
      assert.strictEqual(bytes, 4);
      assert.strictEqual(client.flags, number);
    });

    gently.expect(PACKET, 'writeNumber', function(bytes, number) {
      assert.strictEqual(bytes, 4);
      assert.strictEqual(client.maxPacketSize, number);
    });

    gently.expect(PACKET, 'writeNumber', function(bytes, number) {
      assert.strictEqual(bytes, 1);
      assert.strictEqual(client.charsetNumber, number);
    });

    gently.expect(PACKET, 'writeFiller', function(bytes) {
      assert.strictEqual(bytes, 23);
    });

    gently.expect(PACKET, 'writeNullTerminated', function(user) {
      assert.strictEqual(user, client.user);
    });

    gently.expect(PACKET, 'writeLengthCoded', function(token) {
      assert.strictEqual(token, TOKEN);
    });

    gently.expect(PACKET, 'writeNullTerminated', function(database) {
      assert.strictEqual(database, client.database);
    });

    gently.expect(client, 'write', function(packet) {
      assert.strictEqual(packet, PACKET);
    });
  });

  client._greetingPacket(GREETING);
});

test(function write() {
  var PACKET = {buffer: []}
    , CONNECTION = client._connection = {};

  gently.expect(CONNECTION, 'write', function(buffer) {
    assert.strictEqual(buffer, PACKET.buffer);
  });

  client.write(PACKET);
});

test(function _errorPacket() {
  var packet = {errorMessage: 'Super', errorNumber: 127};

  gently.expect(client, '_dequeue', function(err) {
    assert.ok(err instanceof Error);
    assert.equal(err.message, packet.errorMessage);
    assert.equal(err.number, packet.errorNumber);
  });
  
  client._errorPacket(packet);
});

test(function _okPacket() {
  var packet =
    { affectedRows: 127
    , insertId: 23
    , serverStatus: 2
    , message: 'hello world\0\0'
    };

  gently.expect(client, '_dequeue', function(err, result) {
    assert.strictEqual(err, null);
    packet.message = 'hello world';
    assert.notStrictEqual(result, packet);
    assert.deepEqual(result, packet);
  });

  client._okPacket(packet);
});

test(function _enqueue() {
  var FN = gently.expect(function fn() {
    
      })
    , CB = function() {
      
      };

  client._enqueue(FN, CB);
  assert.equal(client._queue.length, 1);
  assert.strictEqual(client._queue[0].fn, FN);
  assert.strictEqual(client._queue[0].cb, CB);

  // Make sure fn is only called once
  client._enqueue(FN, CB);
  assert.equal(client._queue.length, 2);
  assert.strictEqual(client._queue[1].fn, FN);
  assert.strictEqual(client._queue[1].cb, CB);
});

test(function _dequeue() {
  (function testErrorWithCb() {
    var ERR = new Error('oh no!')
      , CB = gently.expect(function cb(err) {
          assert.strictEqual(err, ERR);
        });

    client._queue = [{cb: CB}];  
    client._dequeue(ERR);
    assert.equal(client._queue.length, 0);
  })();

  (function testErrWithoutCb() {
    var ERR = new Error('oh no!');
    client._queue = [{}];
  
    gently.expect(client, 'emit', function(event, err) {
      assert.equal(event, 'error');
      assert.strictEqual(err, ERR);
    });
  
    client._dequeue(ERR);
  })();

  (function testExecuteNext() {
    var FN = gently.expect(function fn() {});
    client._queue = [{}, {fn: FN}];

    client._dequeue();
    assert.equal(client._queue.length, 1);
  })();
});

test(function query() {
  var PACKET
    , SQL = 'SELECT über'
    , CB = function() {};

  gently.expect(client, '_enqueue', function(fn, cb) {
    assert.strictEqual(cb, CB);
    fn();
  });

  gently.expect(OutgoingPacketStub, 'new', function(size) {
    PACKET = this;

    assert.equal(size, Buffer.byteLength(SQL, 'utf-8') + 1);

    gently.expect(PACKET, 'writeNumber', function(bytes, number) {
      assert.strictEqual(bytes, 1);
      assert.strictEqual(number, Client.COM_QUERY);
    });

    gently.expect(PACKET, 'write', function(str, encoding) {
      assert.equal(str, SQL);
      assert.equal(encoding, 'utf-8');
    });

    gently.expect(client, 'write', function(packet) {
      assert.strictEqual(packet, PACKET);
    });
  });

  client.query(SQL, CB);
});

test(function end() {
  client._connection = {};

  gently.expect(client._connection, 'end');

  client.end();
});