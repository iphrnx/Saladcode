declare module 'heic-decode' {
  interface HeicDecodeOptions {
    buffer: ArrayBuffer | Uint8Array
  }

  interface HeicDecodeResult {
    width: number
    height: number
    data: Uint8Array
  }

  export default function decode(options: HeicDecodeOptions): Promise<HeicDecodeResult>
}
