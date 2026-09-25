declare module 'qrcode' {
  interface QRCodeOptions {
    errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H';
    version?: number;
    maskPattern?: number;
    margin?: number;
    width?: number;
    color?: { dark?: string; light?: string };
    type?: 'svg' | 'utf8' | 'terminal';
  }

  interface QRCodeResult {
    modules: {
      size: number;
      get(row: number, col: number): boolean;
    };
  }

  function create(text: string, options?: QRCodeOptions): QRCodeResult;
  function toString(text: string, options?: QRCodeOptions): Promise<string>;

  export default { create, toString };
}
