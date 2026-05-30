const { wake } = require('wake_on_lan');

function getBroadcastAddress(ip) {
  if (!ip || typeof ip !== 'string') return '255.255.255.255';
  const parts = ip.trim().split('.');
  if (parts.length !== 4) return '255.255.255.255';
  return `${parts[0]}.${parts[1]}.${parts[2]}.255`;
}

function sendMagicPacket(mac, ip, options = {}) {
  const port = options.port || 9;
  const repeat = options.repeat || 3;
  const delay = options.delay || 1000;
  const broadcast = options.broadcast || getBroadcastAddress(ip);

  return new Promise((resolve, reject) => {
    wake(mac, { address: broadcast, port, num_packets: repeat, interval: delay }, error => {
      if (error) return reject(error);
      resolve();
    });
  });
}

module.exports = {
  sendMagicPacket,
};
