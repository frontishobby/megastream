declare module 'mux.js' {
  const muxjs: {
    mp4: {
      Transmuxer: new (options?: { keepOriginalTimestamps?: boolean }) => {
        on(event: 'data', cb: (segment: {
          initSegment: Uint8Array;
          data: Uint8Array;
        }) => void): void;
        push(data: Uint8Array): void;
        flush(): void;
        dispose(): void;
      };
    };
  };
  export default muxjs;
}
