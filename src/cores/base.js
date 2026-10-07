export class CoreError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "CoreError";
    this.status = status;
  }
}

// A source (ranobelib, mangalib, or a later one). Methods return plain data and
// EPUB bytes. They do not touch the filesystem, so Node and React Native can
// both call them and decide where to save the file.
export class Core {
  id = "";
  name = "";
  description = "";
  linkRe = "";
  placeholder = "Search by title or paste a link";

  public() {
    return {
      id: this.id,
      name: this.name || this.id,
      description: this.description,
      link: this.linkRe,
      placeholder: this.placeholder,
    };
  }

  async search() {
    throw new CoreError("This source has no search.", 501);
  }

  async info() {
    throw new CoreError("This source has no book info.", 501);
  }

  async build() {
    throw new CoreError("This source cannot build an EPUB.", 501);
  }
}
