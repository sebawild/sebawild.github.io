import java.util.Objects;

public class SubArrayProblem {

    /**
     * Code for 1-dimensional Max Subarray Problem
     */

    static class Result {

        private int start, sum, end;

        Result(int sum, int start, int end) {
            this.sum = sum;
            this.start = start;
            this.end = end;
        }

        public void setValues(Result result){
            this.start = result.start;
            this.sum = result.sum;
            this.end = result.end;
        }

        public void setValues(int sum, int start, int end){
            this.sum = sum;
            this.start = start;
            this.end = end;
        }

    }

    private static Result maxSubarrayProblem(int[] arr){
        Result result = new Result(arr[0], 0, 0);
        Result currentResult = new Result(arr[0], 0, 0);

        for (int i = 1; i < arr.length; i++) {
            int extendedSum = arr[i] + currentResult.sum;

            if(arr[i] > extendedSum){
                currentResult.setValues(arr[i], i, i);
            } else {
                currentResult.sum = extendedSum;
                currentResult.end = i;
            }

            if (currentResult.sum > result.sum) {
                result.setValues(currentResult);
            }
        }
        return result;
    }

    /**
     * Code for 2-dimensional Max Subarray Problem
     */

    static class SubMatrix {

        private final int xStart, xEnd, yStart, yEnd;

        SubMatrix(int xStart, int xEnd, int yStart, int yEnd) {
            this.xStart = xStart;
            this.xEnd = xEnd;
            this.yStart = yStart;
            this.yEnd = yEnd;
        }

        @Override
        public boolean equals(Object o) {
            if (this == o) return true;
            if (o == null || getClass() != o.getClass()) return false;
            SubMatrix subMatrix = (SubMatrix) o;
            return xStart == subMatrix.xStart && xEnd == subMatrix.xEnd && yStart == subMatrix.yStart && yEnd == subMatrix.yEnd;
        }

        @Override
        public int hashCode() {
            return Objects.hash(xStart, xEnd, yStart, yEnd);
        }

        @Override
        public String toString() {
            return "SubMatrix{" +
                    "xStart=" + xStart +
                    ", xEnd=" + xEnd +
                    ", yStart=" + yStart +
                    ", yEnd=" + yEnd +
                    '}';
        }
    }

    static class SubMatrixSum {
        private final SubMatrix subMatrix;
        private final int sum;

        SubMatrixSum(SubMatrix subMatrix, int sum) {
            this.subMatrix = subMatrix;
            this.sum = sum;
        }

        @Override
        public boolean equals(Object o) {
            if (this == o) return true;
            if (o == null || getClass() != o.getClass()) return false;
            SubMatrixSum that = (SubMatrixSum) o;
            return sum == that.sum && Objects.equals(subMatrix, that.subMatrix);
        }

        @Override
        public int hashCode() {
            return Objects.hash(subMatrix, sum);
        }

        @Override
        public String toString() {
            return "SubMatrixSum{" +
                    "subMatrix=" + subMatrix +
                    ", sum=" + sum +
                    '}';
        }
    }

    private static void validateMatrix(int[][] matrix){
        int rowMax = matrix.length;
        int colMax = matrix[0].length;

        if(rowMax != colMax) {
            throw new IllegalArgumentException("Matrix is not quadratic");
        }

        for (int i = 0; i < rowMax; i++) {
            if(matrix[i].length != colMax) {
                throw new IllegalArgumentException("Matrix size is invalid");
            }
        }
    }

    private static int subMatrixSum(SubMatrix subMatrix, int[][] matrix){
        int sum = 0;
        for (int x = subMatrix.xStart; x <= subMatrix.xEnd; x++) {
            for (int y = subMatrix.yStart; y <= subMatrix.yEnd; y++) {
                sum += matrix[x][y];
            }
        }
        return sum;
    }

    public static SubMatrixSum bruteForce(int[][] matrix) {
        validateMatrix(matrix);

        int rowMax = matrix.length;
        int colMax = matrix[0].length;
        int sum = Integer.MIN_VALUE;
        SubMatrix result = null;

        for(int xStart = 0; xStart < rowMax; xStart ++){
            for (int xEnd = 0; xEnd < rowMax; xEnd++) {
                for (int yStart = 0; yStart < colMax; yStart++) {
                    for (int yEnd = 0; yEnd < colMax; yEnd++) {
                        SubMatrix currentSubMatrix = new SubMatrix(xStart, xEnd, yStart, yEnd);
                        int currentSum = subMatrixSum(currentSubMatrix, matrix);
                        if(currentSum >= sum){
                            result = currentSubMatrix;
                            sum = currentSum;
                        }
                    }
                }
            }
        }

        return new SubMatrixSum(result, sum);
    }

    private static SubMatrixSum efficient(int[][] matrix){
        //TODO 1.4c)
        return null;
    }

}
