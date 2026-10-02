const fail=()=>{throw new Error('Invalid web subject binding')}
const digest=value=>typeof value==='string'&&/^sha256:[0-9a-f]{64}$/.test(value)

function spdxHeader(spdx) {
  if(spdx.spdxVersion!=='SPDX-2.3'||spdx.dataLicense!=='CC0-1.0'||spdx.SPDXID!=='SPDXRef-DOCUMENT')fail()
  if(typeof spdx.name!=='string'||!spdx.name.trim()||typeof spdx.documentNamespace!=='string'||!/^https?:\/\/\S+$/.test(spdx.documentNamespace))fail()
}
function subjectFor(spdx) {
  if(!Array.isArray(spdx.packages)||spdx.packages.length<2)fail()
  if(!spdx.creationInfo?.creators?.includes('Tool: trivy-0.74.0'))fail()
  const subjects=spdx.packages.filter(item=>item.primaryPackagePurpose==='CONTAINER')
  if(subjects.length!==1)fail()
  return subjects[0]
}
function imageAnnotations(subject,configDigest,diffIds) {
  const annotations=subject.annotations?.map(item=>item.comment)??[]
  if(annotations.filter(value=>typeof value==='string'&&value.startsWith('ImageID: ')).length!==1||!annotations.includes('ImageID: '+configDigest))fail()
  const differences=annotations.filter(value=>typeof value==='string'&&value.startsWith('DiffID: ')).map(value=>value.slice(8)).sort()
  if(JSON.stringify(differences)!==JSON.stringify([...diffIds].sort()))fail()
}
function imageRelationships(spdx,subject) {
  if(!spdx.relationships?.some(item=>item.spdxElementId==='SPDXRef-DOCUMENT'&&item.relatedSpdxElement===subject.SPDXID&&item.relationshipType==='DESCRIBES'))fail()
  if(!spdx.relationships.some(item=>item.spdxElementId===subject.SPDXID&&item.relationshipType==='CONTAINS'&&spdx.packages.some(pkg=>pkg.SPDXID===item.relatedSpdxElement&&pkg!==subject)))fail()
}
/** Exact native Trivy subject semantics, consumed by writer and offline validator. */
export function bindWebSbom(spdx,configDigest,diffIds) {
  if(!digest(configDigest)||!Array.isArray(diffIds)||!diffIds.length||diffIds.length>128||!diffIds.every(digest))fail()
  spdxHeader(spdx)
  const subject=subjectFor(spdx)
  imageAnnotations(subject,configDigest,diffIds)
  imageRelationships(spdx,subject)
}
