const CHUNK_SIZE = 64 * 1024;

function writeSftpFile(sftp, remotePath, buffer, onProgress = () => {}) {
  return new Promise((resolve, reject) => {
    sftp.open(remotePath, 'w', (openError, handle) => {
      if (openError) {
        reject(openError);
        return;
      }

      let offset = 0;
      const close = (writeError) => {
        sftp.close(handle, (closeError) => {
          if (writeError || closeError) {
            reject(writeError || closeError);
            return;
          }
          resolve();
        });
      };

      const writeNext = () => {
        if (offset >= buffer.length) {
          close();
          return;
        }

        const length = Math.min(CHUNK_SIZE, buffer.length - offset);
        // ponytail: sequential writes favor reliable progress; pipeline chunks if latency limits throughput.
        sftp.write(handle, buffer, offset, length, offset, (writeError, written) => {
          if (writeError) {
            close(writeError);
            return;
          }
          if (!Number.isInteger(written) || written <= offset || written > offset + length) {
            close(new Error(`Invalid SFTP write result: ${written}`));
            return;
          }

          // ssh2 reports the acknowledged absolute buffer offset, not this call's byte count.
          offset = written;
          onProgress(offset, buffer.length);
          writeNext();
        });
      };

      writeNext();
    });
  });
}

module.exports = { writeSftpFile };
