import CryptoJS from 'crypto-js';

const wsKey = '63dwReOhAlDbUoXiMFyZPgSvQc4JnTr7La0EjWf3Cu6NzBt9Ks1HxGq2Rd8Ym5Vp'.split('').reverse().join('');

const encodeVarint = (value: number) => {
  const bytes: number[] = [];
  let current = value >>> 0;
  while (current > 127) { bytes.push((current & 127) | 128); current >>>= 7; }
  bytes.push(current);
  return bytes;
};

const encodeString = (field: number, value: string) => {
  const data = new TextEncoder().encode(value);
  return [...encodeVarint((field << 3) | 2), ...encodeVarint(data.length), ...data];
};

const encodeInt = (field: number, value: number) => [...encodeVarint(field << 3), ...encodeVarint(value)];

const encrypt = (value: string) => CryptoJS.TripleDES.encrypt(value, CryptoJS.enc.Utf8.parse(wsKey), {
  mode: CryptoJS.mode.ECB, padding: CryptoJS.pad.Pkcs7,
}).toString();

export const dgSocketUrl = (baseUrl: string, token: string) => `${baseUrl.replace(/\/$/, '')}/?sign=${encodeURIComponent(encrypt(token))}`;

export const dgLoginPacket = (token: string): ArrayBuffer => {
  const command = 10086;
  const signedToken = encrypt(JSON.stringify({ cmd: command, token, time: Date.now() }));
  const bytes = new Uint8Array([
    ...encodeInt(1, command),
    ...encodeString(2, signedToken),
    ...encodeInt(6, 1),
    ...encodeInt(10, 0),
    ...encodeString(14, 'PC'),
  ]);
  return bytes.buffer;
};
