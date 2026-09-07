import type { ScoutWalletAssociation } from "../types/domain.js";
import { createFileRepository, type FileRepository } from "./fileRepository.js";

export type ScoutWalletAssociationRepository = FileRepository<ScoutWalletAssociation>;

export function createScoutWalletAssociationRepository(filePath: string): ScoutWalletAssociationRepository {
  return createFileRepository<ScoutWalletAssociation>({
    filePath,
    getId: (association) => association.id,
    mode: "append",
  });
}
