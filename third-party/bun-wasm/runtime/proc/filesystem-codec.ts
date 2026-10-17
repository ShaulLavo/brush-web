import { OpenDescription, type Descriptor, type Resource } from "../core/descriptors";
import { shareFileResource } from "../core/open-file";
import { FilesystemClient } from "../fs/client";
import { releaseFilesystemReservation, type FilesystemIdentity, type FilesystemReservation } from "../fs/protocol";
import type { WorkerDescriptorCodec } from "./worker-client";

export interface FilesystemDescriptorToken {
  kind: "filesystem";
  resource: "file" | "directory";
  reservation: FilesystemReservation;
  offset?: SharedArrayBuffer;
}
export function isFilesystemDescriptorToken(token: unknown): token is FilesystemDescriptorToken {
  return typeof token === "object" && token !== null && "kind" in token && token.kind === "filesystem";
}

/** Controller imports need only the identity and a live controller sweep notifier; guests pass
 * their actual client. Both import the same reference, whose release is shared and idempotent. */
export function createFilesystemDescriptorCodec(filesystem: FilesystemClient | FilesystemIdentity, target?: FilesystemIdentity, sweep?: () => void): WorkerDescriptorCodec {
  const client = filesystem instanceof FilesystemClient ? filesystem : undefined;
  const identity = client?.connection ?? filesystem as FilesystemIdentity;
  const discard = (token: unknown) => {
    if (!isFilesystemDescriptorToken(token)) throw new TypeError("not a filesystem descriptor token");
    if (client && token.reservation.targetOwner === client.connection.owner) client.releaseReservation(token.reservation);
    else { releaseFilesystemReservation(token.reservation); (sweep ?? (() => client?.sweep()))(); }
  };
  return {
    export(descriptor: Descriptor): FilesystemDescriptorToken {
      const resource = descriptor.resource;
      if (resource.kind !== "file" && resource.kind !== "directory") throw new TypeError("not a filesystem descriptor");
      if (!client || !target) throw new TypeError("filesystem export requires a client and child identity");
      // Promote before reserving: a failed offset conversion cannot strand a child pin.
      const offset = resource.kind === "file" ? shareFileResource(resource, identity) : undefined;
      return { kind: "filesystem", resource: resource.kind, reservation: client.reserve(resource.handle, target), offset };
    },
    import(token: unknown): OpenDescription {
      if (!isFilesystemDescriptorToken(token)) throw new TypeError("not a filesystem descriptor token");
      if (token.reservation.targetOwner !== identity.owner) throw new TypeError("filesystem descriptor belongs to another process");
      const handle = token.reservation.handle;
      let resource: Resource;
      if (token.resource === "file") {
        if (!(token.offset instanceof SharedArrayBuffer)) throw new TypeError("file offset is missing");
        resource = { kind: "file", handle, offset: 0, append: false };
        shareFileResource(resource, identity, token.offset);
      } else resource = { kind: "directory", handle };
      client?.adopt(token.reservation);
      return new OpenDescription(resource, () => discard(token));
    },
    discard,
  };
}
