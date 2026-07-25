declare module 'qrcode' {
  interface QRCodeOptions {
    errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H';
    version?: number;
    maskPattern?: number;
  }

  interface QRCodeResult {
    modules: {
      size: number;
      get(row: number, col: number): boolean;
    };
  }

  function create(text: string, options?: QRCodeOptions): QRCodeResult;

  export default { create };
}
