import QRCode from 'qrcode';
import { deepLink } from '../config.js';

export async function roomQr(code: string): Promise<Buffer> {
  return QRCode.toBuffer(deepLink(code), {
    type: 'png',
    width: 512,
    margin: 2,
    errorCorrectionLevel: 'M',
    color: { dark: '#000000', light: '#FFFFFF' },
  });
}
